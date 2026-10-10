/**
 * Minimal Steam Web API and store clients. Only the fields we use are typed.
 *
 * The Web API key travels in the query string, so request URLs are never put in error messages.
 */

import { parseRetryAfter } from '../shared/http.js';

export interface PlayerSummary {
  steamid: string;
  personaname?: string;
  profileurl?: string;
  avatarfull?: string;
  /** 0 offline (or Invisible), 1 online, 2 busy, 3 away, 4 snooze, 5 looking to trade, 6 looking to play. */
  personastate?: number;
  /** 1 = not visible to the key's account, 3 = public (visible). */
  communityvisibilitystate?: number;
  /** Set while in a game: a Steam app id, or a 64-bit id for a non-Steam shortcut. */
  gameid?: string;
  /** The game's name; also set for non-Steam shortcuts. */
  gameextrainfo?: string;
}

export interface StoreApp {
  name?: string;
  /** Landscape store header (460×215), on Steam's public CDN. */
  headerImage?: string;
}

export class SteamError extends Error {
  constructor(
    message: string,
    /** How long the server asked us to wait (Retry-After), if it did. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const API = 'https://api.steampowered.com';
const STORE = 'https://store.steampowered.com/api/appdetails';

/** undici's "fetch failed" hides the useful part in `cause`. */
function networkMessage(err: unknown): string {
  const e = err as Error & { cause?: Error };
  return e?.cause?.message ?? e?.message ?? String(err);
}

export type SteamIdInput = { steamId: string } | { vanity: string };

/**
 * Parse what the user typed: a SteamID64, a profile URL (`/profiles/<id>` or `/id/<name>`), or a
 * custom URL name.
 */
export function parseSteamId(input: string): SteamIdInput | undefined {
  const text = input.trim();
  if (/^\d{17}$/.test(text)) return { steamId: text };
  const url = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/(profiles|id)\/([^/?#]+)/i.exec(text);
  if (url) {
    const [, kind, value] = url as unknown as [string, string, string];
    if (kind.toLowerCase() === 'id') return { vanity: decodeURIComponent(value) };
    return /^\d{17}$/.test(value) ? { steamId: value } : undefined;
  }
  return /^[\w-]+$/.test(text) ? { vanity: text } : undefined;
}

export class SteamClient {
  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  /** Never let the key reach a log line or the UI, whatever an error message contains. */
  private redact(text: string): string {
    return this.key ? text.split(this.key).join('***') : text;
  }

  private async get<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${API}/ISteamUser/${method}/`);
    url.searchParams.set('key', this.key);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const name = method.split('/')[0];
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new SteamError(this.redact(`Could not reach the Steam Web API: ${networkMessage(err)}`));
    }
    // Steam answers a bad key with an HTML 403 page.
    if (res.status === 401 || res.status === 403) throw new SteamError('Steam rejected the Web API key');
    const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
    if (res.status === 429) throw new SteamError('Steam is rate limiting requests (429)', retryAfter);
    if (!res.ok) throw new SteamError(`Steam ${name} failed (${res.status})`, retryAfter);
    const body = (await res.json().catch(() => undefined)) as { response?: T } | undefined;
    if (!body?.response) throw new SteamError(`Steam ${name} returned an unexpected response`);
    return body.response;
  }

  /** The SteamID64 for a custom profile URL name. */
  async resolveVanity(vanity: string): Promise<string> {
    const r = await this.get<{ success?: number; steamid?: string; message?: string }>('ResolveVanityURL/v1', { vanityurl: vanity });
    if (r.success !== 1 || !r.steamid) throw new SteamError(`No Steam profile has the custom URL "${vanity}"`);
    return r.steamid;
  }

  async summary(steamId: string): Promise<PlayerSummary> {
    const r = await this.get<{ players?: PlayerSummary[] }>('GetPlayerSummaries/v2', { steamids: steamId });
    const player = r.players?.find((p) => p.steamid === steamId) ?? r.players?.[0];
    if (!player) throw new SteamError(`Steam has no profile with the ID ${steamId}`);
    return player;
  }
}

type StoreEntry = { app: StoreApp | null; until: number };

/** How long to remember that the store has no page for an app. */
const MISSING_TTL_MS = 24 * 3600_000;
/** After a failed lookup, wait this long (or as long as Retry-After says) before asking again. */
const FAILED_RETRY_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

/**
 * Store details (name, header image) per app id, from the storefront's `appdetails` API. It is
 * rate limited per IP (roughly 200 requests per 5 minutes), so every answer is cached, lookups for
 * the same app share one request, and a failure pauses all lookups for a while.
 */
export class SteamStore {
  private readonly cache = new Map<string, StoreEntry>();
  private readonly pending = new Map<string, Promise<StoreApp | null | undefined>>();
  private pausedUntil = 0;
  /** Why the last lookup failed, for the status page. */
  lastError: string | undefined;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  /**
   * The app's store details; `null` if the store has no page for it (e.g. a delisted or tool app);
   * `undefined` if the lookup failed or is paused. Throws nothing.
   */
  async app(appId: string, now = Date.now()): Promise<StoreApp | null | undefined> {
    const hit = this.cache.get(appId);
    if (hit && (hit.app || hit.until > now)) return hit.app;
    if (now < this.pausedUntil) return undefined;
    let p = this.pending.get(appId);
    if (!p) {
      p = this.fetchApp(appId, now).finally(() => this.pending.delete(appId));
      this.pending.set(appId, p);
    }
    return p;
  }

  private async fetchApp(appId: string, now: number): Promise<StoreApp | null | undefined> {
    const url = `${STORE}?appids=${encodeURIComponent(appId)}&filters=basic`;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) {
        this.pausedUntil = now + Math.max(parseRetryAfter(res.headers.get('Retry-After')) ?? 0, FAILED_RETRY_MS);
        this.lastError = `Steam store lookup failed (${res.status})`;
        return undefined;
      }
      const body = (await res.json().catch(() => undefined)) as
        | Record<string, { success?: boolean; data?: { name?: string; header_image?: string } } | undefined>
        | null
        | undefined;
      const entry = body?.[appId];
      if (!entry) {
        this.pausedUntil = now + FAILED_RETRY_MS;
        this.lastError = 'Steam store returned an unexpected response';
        return undefined;
      }
      this.lastError = undefined;
      const header = entry.data?.header_image;
      const app = entry.success && entry.data ? { name: entry.data.name, headerImage: header?.startsWith('https://') ? header : undefined } : null;
      if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(appId, { app, until: now + MISSING_TTL_MS });
      return app;
    } catch (err) {
      this.pausedUntil = now + FAILED_RETRY_MS;
      this.lastError = `Could not reach the Steam store: ${networkMessage(err)}`;
      return undefined;
    }
  }
}
