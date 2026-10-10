import fs from 'node:fs';
import { errorMessage } from '../../core/log.js';
import { parseRetryAfter } from '../shared/http.js';

/**
 * Minimal Trakt API client: what a user is watching, and OAuth device-code sign-in for private
 * profiles. Only the fields we use are typed. OAuth requests go to auth.trakt.tv, as Trakt asks;
 * everything else to api.trakt.tv.
 */

export const API_URL = 'https://api.trakt.tv';
export const AUTH_URL = 'https://auth.trakt.tv';
/** Trakt's token refresh wants a redirect URI; device-flow apps register the out-of-band one. */
export const DEVICE_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

export interface TraktIds {
  trakt?: number;
  slug?: string;
  imdb?: string | null;
  tmdb?: number | null;
  tvdb?: number | null;
}

export interface TraktMovie {
  title?: string;
  year?: number | null;
  ids?: TraktIds;
}

export interface TraktShow {
  title?: string;
  year?: number | null;
  ids?: TraktIds;
}

export interface TraktEpisode {
  season?: number;
  number?: number;
  title?: string | null;
  ids?: TraktIds;
}

/** `GET /users/{id}/watching`. There's no paused state: pausing a scrobble ends "watching". */
export interface TraktWatching {
  started_at?: string;
  expires_at?: string;
  action?: string; // scrobble | checkin
  type?: string; // movie | episode
  movie?: TraktMovie | null;
  show?: TraktShow | null;
  episode?: TraktEpisode | null;
}

export interface TraktUser {
  username?: string;
  name?: string | null;
  ids?: { slug?: string };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  expiresAt: number;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  /** Seconds between token polls. */
  interval: number;
  /** Epoch ms. */
  expiresAt: number;
}

export type DevicePoll =
  | { status: 'ok'; tokens: TokenSet }
  | { status: 'pending' }
  | { status: 'slow_down'; retryAfterMs?: number }
  | { status: 'failed'; message: string };

export class TraktError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** From Retry-After, on 429s. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Trakt no longer accepts the saved tokens: the user has to connect again. */
export class TraktAuthError extends TraktError {}

export interface ClientOptions {
  clientId: string;
  /** Deprecated by Trakt and optional; sent only when set. */
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class TraktClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent = userAgent();

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** What `user` (a slug, or `me` with a token) is watching, or null. */
  async watching(user: string, accessToken?: string): Promise<TraktWatching | null> {
    const res = await this.send(`${API_URL}/users/${encodeURIComponent(user)}/watching`, { accessToken });
    if (res.status === 204) return null;
    if (res.ok) {
      const body = (await res.json().catch(() => undefined)) as TraktWatching | undefined;
      return body && (body.movie || body.episode) ? body : null;
    }
    if (res.status === 401) {
      throw new TraktError(
        accessToken ? 'Trakt rejected the access token' : `${user}'s Trakt profile is private; connect your Trakt account to show it`,
        401,
      );
    }
    if (res.status === 404) throw new TraktError(`Trakt user "${user}" not found`, 404);
    throw await apiError(res);
  }

  /** The signed-in user's profile. */
  async me(accessToken: string): Promise<TraktUser> {
    const res = await this.send(`${API_URL}/users/me`, { accessToken });
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as TraktUser;
  }

  async deviceCode(): Promise<DeviceCode> {
    const res = await this.send(`${AUTH_URL}/oauth/device/code`, { body: { client_id: this.opts.clientId } });
    if (!res.ok) throw await apiError(res, 'Trakt device code request failed');
    const body = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_url: string;
      expires_in: number;
      interval: number;
    };
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUrl: body.verification_url,
      interval: Math.max(1, Number(body.interval) || 5),
      expiresAt: Date.now() + (Number(body.expires_in) || 600) * 1000,
    };
  }

  /** One poll of the device token endpoint; Trakt answers with a status code per state. */
  async pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
    const res = await this.send(`${AUTH_URL}/oauth/device/token`, {
      body: { code: deviceCode, client_id: this.opts.clientId, ...this.secret() },
    });
    switch (res.status) {
      case 200:
        return { status: 'ok', tokens: await tokenSet(res) };
      case 400:
        return { status: 'pending' };
      case 429:
        return { status: 'slow_down', retryAfterMs: parseRetryAfter(res.headers.get('Retry-After')) };
      case 404:
        return { status: 'failed', message: "Trakt didn't recognise the code. Connect again." };
      case 409:
        return { status: 'failed', message: 'That code was already used. Connect again.' };
      case 410:
        return { status: 'failed', message: 'The code expired before it was entered. Connect again.' };
      case 418:
        return { status: 'failed', message: 'Access was denied on Trakt.' };
      default:
        throw await apiError(res, 'Trakt device token request failed');
    }
  }

  /** Exchange a refresh token. Trakt's refresh tokens are single-use: store the new set at once. */
  async refresh(refreshToken: string): Promise<TokenSet> {
    const res = await this.send(`${AUTH_URL}/oauth/token`, {
      body: {
        refresh_token: refreshToken,
        client_id: this.opts.clientId,
        ...this.secret(),
        redirect_uri: DEVICE_REDIRECT_URI,
        grant_type: 'refresh_token',
      },
    });
    if (res.ok) return tokenSet(res);
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    if ((res.status === 400 || res.status === 401) && body.error) {
      throw new TraktAuthError(
        `Trakt no longer accepts this connection (${[body.error, body.error_description].filter(Boolean).join(': ')}); connect again`,
        res.status,
      );
    }
    throw new TraktError(`Trakt token refresh failed (${res.status})`, res.status, parseRetryAfter(res.headers.get('Retry-After')));
  }

  /** Best effort: tell Trakt to forget the token. */
  async revoke(accessToken: string): Promise<void> {
    await this.send(`${AUTH_URL}/oauth/revoke`, { body: { token: accessToken, client_id: this.opts.clientId, ...this.secret() } });
  }

  private secret(): { client_secret?: string } {
    return this.opts.clientSecret ? { client_secret: this.opts.clientSecret } : {};
  }

  private async send(url: string, opts: { accessToken?: string; body?: unknown }): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
      'trakt-api-version': '2',
      'trakt-api-key': this.opts.clientId,
    };
    if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
    try {
      return await this.fetchImpl(url, {
        method: opts.body === undefined ? 'GET' : 'POST',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new TraktError(`Could not reach Trakt: ${errorMessage(err)}`);
    }
  }
}

async function tokenSet(res: Response): Promise<TokenSet> {
  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  if (!body.access_token || !body.refresh_token) throw new TraktError('Trakt sent an incomplete token response');
  const now = Date.now();
  // Trakt has changed the lifetime before (3 months, then 24 hours, now 7 days): trust expires_in.
  return { accessToken: body.access_token, refreshToken: body.refresh_token, createdAt: now, expiresAt: now + Number(body.expires_in || 0) * 1000 };
}

/** A TraktError for a failed API response, with Retry-After and the rate-limit bucket on 429s. */
async function apiError(res: Response, prefix = 'Trakt request failed'): Promise<TraktError> {
  const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'));
  switch (res.status) {
    case 403:
      return new TraktError('Trakt rejected the client ID (invalid API key or unapproved app)', 403);
    case 423:
      return new TraktError('This Trakt account is locked or deactivated; contact Trakt support', 423);
    case 429: {
      const bucket = rateLimitBucket(res.headers.get('X-Ratelimit'));
      return new TraktError(`Trakt rate limit reached${bucket ? ` (${bucket})` : ''}`, 429, retryAfterMs);
    }
  }
  if (res.status >= 500) return new TraktError(`Trakt is unavailable (${res.status})`, res.status, retryAfterMs);
  const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
  const detail = [body.error, body.error_description].filter(Boolean).join(': ');
  return new TraktError(`${prefix} (${res.status})${detail ? `: ${detail}` : ''}`, res.status, retryAfterMs);
}

/** The bucket name from Trakt's `X-Ratelimit` JSON header, e.g. `AUTHED_API_GET_LIMIT`. */
export function rateLimitBucket(header: string | null): string | undefined {
  if (!header) return undefined;
  try {
    const name = (JSON.parse(header) as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Trakt asks for `AppName/version`: `name/version (+homepage)` from package.json. */
export function userAgent(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      name?: string;
      version?: string;
      homepage?: string;
    };
    return `${pkg.name ?? 'understudy'}/${pkg.version ?? '0.0.0'}${pkg.homepage ? ` (+${pkg.homepage})` : ''}`;
  } catch {
    return 'understudy/0.0.0';
  }
}
