import crypto from 'node:crypto';
import type { ActivityLink } from '../../core/activity.js';
import { errorMessage, type Logger } from '../../core/log.js';
import { AlbumArtFinder } from '../shared/album-art.js';
import { externalLinks, TmdbClient, type ExternalIds } from '../shared/tmdb.js';
import type { JellyfinClient, JellyfinSession } from './client.js';
import { imageItemId, mediaKind, sessionKey } from './session.js';

/**
 * Finds a public HTTPS image (and optional links) for a session. Discord fetches images itself, so
 * the server's own image URLs won't do: they're usually private.
 *
 * Order: TMDB poster (movies/shows; needs a TMDB key) or album art from iTunes/Deezer (music, no
 * key), then this app's own signed image proxy (needs a public HTTPS PUBLIC_URL), then a fallback.
 */

export interface Artwork {
  url?: string;
  source: 'tmdb' | 'itunes' | 'deezer' | 'proxy' | 'fallback' | 'none';
  links: ActivityLink[];
}

export interface ArtworkOptions {
  client: JellyfinClient;
  log: Logger;
  tmdbKey?: string;
  /** Look up album art for music (iTunes, then Deezer). */
  albumArt: boolean;
  /** Builds a proxy URL for an item's primary image, or undefined if the proxy is off or unusable. */
  proxyUrl?: (itemId: string) => string | undefined;
  fallback?: string;
  fetchImpl?: typeof fetch;
}

const MAX_CACHE = 200;
const FAILURE_TTL_MS = 10 * 60 * 1000;

/** External ids from `ProviderIds`, whose keys are spelled `Tmdb`, `Imdb`, `Tvdb` (case varies). */
export function parseProviderIds(ids: Record<string, string> | undefined): ExternalIds {
  const out: ExternalIds = {};
  for (const [k, v] of Object.entries(ids ?? {})) {
    const kind = k.toLowerCase();
    if ((kind === 'tmdb' || kind === 'imdb' || kind === 'tvdb') && v) out[kind] ??= String(v);
  }
  return out;
}

export class ArtworkResolver {
  private readonly cache = new Map<string, { at: number; failed: boolean; value: Artwork }>();
  /** Series provider ids by series id: every episode of a show needs the same lookup. */
  private readonly seriesIds = new Map<string, ExternalIds>();
  private readonly fetchImpl: typeof fetch;
  private readonly albums: AlbumArtFinder;
  private readonly tmdb: TmdbClient | undefined;

  constructor(private readonly opts: ArtworkOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.albums = new AlbumArtFinder(this.fetchImpl);
    this.tmdb = opts.tmdbKey ? new TmdbClient(opts.tmdbKey, this.fetchImpl) : undefined;
  }

  async resolve(s: JellyfinSession): Promise<Artwork> {
    const key = sessionKey(s);
    const hit = this.cache.get(key);
    if (hit && (!hit.failed || Date.now() - hit.at < FAILURE_TTL_MS)) return hit.value;

    let failed = false;
    let value: Artwork;
    try {
      value = await this.lookup(s);
    } catch (err) {
      failed = true;
      this.opts.log.warn(`Artwork lookup failed for "${s.NowPlayingItem?.Name}": ${errorMessage(err)}`);
      value = this.lastResort(s, []);
    }
    this.cache.set(key, { at: Date.now(), failed, value });
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private async lookup(s: JellyfinSession): Promise<Artwork> {
    const item = s.NowPlayingItem ?? {};
    const kind = mediaKind(item);
    let links: ActivityLink[] = [];
    if (kind === 'movie' || kind === 'episode') {
      const ids = await this.externalIds(s);
      const type = kind === 'movie' ? 'movie' : 'tv';
      links = externalLinks(type, ids);
      if (this.tmdb) {
        const poster = await this.tmdb.poster(type, ids);
        if (poster) return { url: poster, source: 'tmdb', links };
      }
    } else if (kind === 'track' && this.opts.albumArt) {
      const art = await this.albums.find(item.AlbumArtist || item.Artists?.[0] || '', item.Album ?? '');
      if (art) return { ...art, links };
    }
    return this.lastResort(s, links);
  }

  /** The movie's ids, or for an episode its show's (the episode's own ids are episode ids). */
  private async externalIds(s: JellyfinSession): Promise<ExternalIds> {
    const item = s.NowPlayingItem ?? {};
    if (mediaKind(item) === 'movie') {
      const own = parseProviderIds(item.ProviderIds);
      if (Object.keys(own).length || !item.Id) return own;
      return parseProviderIds((await this.opts.client.item(item.Id, s.UserId))?.ProviderIds);
    }
    if (!item.SeriesId) return {};
    const cached = this.seriesIds.get(item.SeriesId);
    if (cached) return cached;
    const ids = parseProviderIds((await this.opts.client.item(item.SeriesId, s.UserId))?.ProviderIds);
    this.seriesIds.set(item.SeriesId, ids);
    if (this.seriesIds.size > MAX_CACHE) this.seriesIds.delete(this.seriesIds.keys().next().value!);
    return ids;
  }

  private lastResort(s: JellyfinSession, links: ActivityLink[]): Artwork {
    const id = s.NowPlayingItem && imageItemId(s.NowPlayingItem);
    const proxied = id && this.opts.proxyUrl?.(id);
    if (proxied) return { url: proxied, source: 'proxy', links };
    if (this.opts.fallback) return { url: this.opts.fallback, source: 'fallback', links };
    return { source: 'none', links };
  }
}

// ---- signed image proxy ------------------------------------------------------------------------

/** Jellyfin ids are GUIDs (with or without dashes); Emby's are numbers. */
const ITEM_ID = /^[A-Za-z0-9-]{1,64}$/;

/** `<itemId>.<hmac>.jpg`: only items we signed can be fetched through the proxy. */
export function signItem(itemId: string, secret: string): string | undefined {
  return ITEM_ID.test(itemId) ? `${itemId}.${hmac(itemId, secret)}.jpg` : undefined;
}

export function verifyItem(token: string, secret: string): string | undefined {
  const m = /^([^.]+)\.([\w-]+)\.jpg$/.exec(token);
  if (!m || !ITEM_ID.test(m[1]!)) return undefined;
  const expected = Buffer.from(hmac(m[1]!, secret));
  const given = Buffer.from(m[2]!);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return undefined;
  return m[1];
}

function hmac(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`jellyfin-item:${data}`).digest('base64url').slice(0, 22);
}
