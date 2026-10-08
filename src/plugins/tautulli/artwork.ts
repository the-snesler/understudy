import crypto from 'node:crypto';
import type { ActivityLink } from '../../core/activity.js';
import { errorMessage, type Logger } from '../../core/log.js';
import type { TautulliClient, TautulliMetadata, TautulliSession } from './client.js';
import { AlbumArtFinder } from './music.js';
import { mediaKind, metadataKey, sessionKey, thumbPath } from './session.js';

/**
 * Finds a public HTTPS image (and optional links) for a session. Discord fetches images itself, so a
 * Tautulli/Plex URL won't do: it's usually private, and Tautulli's would leak the API key.
 *
 * Order: TMDB poster (movies/shows; needs a TMDB key) or album art from iTunes/Deezer (music, no
 * key), then this app's own signed image proxy (needs a public HTTPS PUBLIC_URL), then a fallback.
 */

export interface ExternalIds {
  imdb?: string;
  tmdb?: string;
  tvdb?: string;
}

export interface Artwork {
  url?: string;
  source: 'tmdb' | 'itunes' | 'deezer' | 'proxy' | 'fallback' | 'none';
  links: ActivityLink[];
}

export interface ArtworkOptions {
  client: TautulliClient;
  log: Logger;
  tmdbKey?: string;
  /** Look up album art for music (iTunes, then Deezer). */
  albumArt: boolean;
  /** Builds a proxy URL for a Plex thumb path, or undefined if the proxy is off or unusable. */
  proxyUrl?: (thumb: string) => string | undefined;
  fallback?: string;
  fetchImpl?: typeof fetch;
}

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMAGES = 'https://image.tmdb.org/t/p/w500';
const MAX_CACHE = 200;
const FAILURE_TTL_MS = 10 * 60 * 1000;

/** Parse external ids from Plex guids: new-agent `imdb://tt…` lists and legacy agent guids. */
export function parseGuids(meta: Pick<TautulliMetadata, 'guid' | 'guids'>): ExternalIds {
  const ids: ExternalIds = {};
  for (const g of [...(meta.guids ?? []), meta.guid ?? '']) {
    const m = /^(?:com\.plexapp\.agents\.)?(imdb|tmdb|themoviedb|tvdb|thetvdb):\/\/([^/?]+)/.exec(g);
    if (!m) continue;
    const kind = m[1] === 'themoviedb' ? 'tmdb' : m[1] === 'thetvdb' ? 'tvdb' : (m[1] as keyof ExternalIds);
    ids[kind] ??= m[2]!;
  }
  return ids;
}

export class ArtworkResolver {
  private readonly cache = new Map<string, { at: number; failed: boolean; value: Artwork }>();
  private readonly fetchImpl: typeof fetch;
  private readonly albums: AlbumArtFinder;

  constructor(private readonly opts: ArtworkOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.albums = new AlbumArtFinder(this.fetchImpl);
  }

  async resolve(s: TautulliSession): Promise<Artwork> {
    const key = sessionKey(s);
    const hit = this.cache.get(key);
    if (hit && (!hit.failed || Date.now() - hit.at < FAILURE_TTL_MS)) return hit.value;

    let failed = false;
    let value: Artwork;
    try {
      value = await this.lookup(s);
    } catch (err) {
      failed = true;
      this.opts.log.warn(`Artwork lookup failed for "${s.full_title ?? s.title}": ${errorMessage(err)}`);
      value = this.lastResort(s, []);
    }
    this.cache.set(key, { at: Date.now(), failed, value });
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private async lookup(s: TautulliSession): Promise<Artwork> {
    const kind = mediaKind(s);
    let links: ActivityLink[] = [];
    if (kind === 'movie' || kind === 'episode') {
      const mk = metadataKey(s);
      const ids = mk ? parseGuids(await this.opts.client.metadata(mk)) : {};
      links = linksFor(kind, ids);
      if (this.opts.tmdbKey) {
        const poster = await this.tmdbPoster(kind === 'movie' ? 'movie' : 'tv', ids);
        if (poster) return { url: poster, source: 'tmdb', links };
      }
    } else if (kind === 'track' && this.opts.albumArt) {
      const art = await this.albums.find(s.grandparent_title ?? '', s.parent_title ?? '');
      if (art) return { ...art, links };
    }
    return this.lastResort(s, links);
  }

  private lastResort(s: TautulliSession, links: ActivityLink[]): Artwork {
    const thumb = thumbPath(s);
    const proxied = thumb && this.opts.proxyUrl?.(thumb);
    if (proxied) return { url: proxied, source: 'proxy', links };
    if (this.opts.fallback) return { url: this.opts.fallback, source: 'fallback', links };
    return { source: 'none', links };
  }

  private async tmdb<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const key = this.opts.tmdbKey!;
    const url = new URL(`${TMDB_API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: 'application/json' };
    // A v4 "read access token" is a JWT; a v3 API key is a short hex string.
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    else url.searchParams.set('api_key', key);
    const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return {} as T;
    if (!res.ok) throw new Error(`TMDB ${path.split('/')[1]} request failed (${res.status})`);
    return (await res.json()) as T;
  }

  private async tmdbPoster(type: 'movie' | 'tv', ids: ExternalIds): Promise<string | undefined> {
    type Item = { poster_path?: string | null };
    if (ids.tmdb) {
      const item = await this.tmdb<Item>(`/${type}/${ids.tmdb}`);
      if (item.poster_path) return TMDB_IMAGES + item.poster_path;
    }
    const lookups: [string | undefined, string][] = [
      [ids.imdb, 'imdb_id'],
      [type === 'tv' ? ids.tvdb : undefined, 'tvdb_id'],
    ];
    for (const [id, source] of lookups) {
      if (!id) continue;
      const found = await this.tmdb<{ movie_results?: Item[]; tv_results?: Item[] }>(`/find/${id}`, {
        external_source: source,
      });
      const item = (type === 'movie' ? found.movie_results : found.tv_results)?.[0];
      if (item?.poster_path) return TMDB_IMAGES + item.poster_path;
    }
    return undefined;
  }
}

function linksFor(kind: 'movie' | 'episode', ids: ExternalIds): ActivityLink[] {
  if (ids.imdb) return [{ label: 'IMDb', url: `https://www.imdb.com/title/${ids.imdb}/` }];
  if (ids.tmdb) return [{ label: 'TMDB', url: `https://www.themoviedb.org/${kind === 'movie' ? 'movie' : 'tv'}/${ids.tmdb}` }];
  return [];
}

// ---- signed image proxy ------------------------------------------------------------------------

/** `<base64url(thumb)>.<hmac>.jpg`: only thumbs we signed can be fetched through the proxy. */
export function signThumb(thumb: string, secret: string): string {
  const data = Buffer.from(thumb).toString('base64url');
  return `${data}.${hmac(data, secret)}.jpg`;
}

export function verifyThumb(token: string, secret: string): string | undefined {
  const m = /^([\w-]+)\.([\w-]+)\.jpg$/.exec(token);
  if (!m) return undefined;
  const expected = Buffer.from(hmac(m[1]!, secret));
  const given = Buffer.from(m[2]!);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return undefined;
  const thumb = Buffer.from(m[1]!, 'base64url').toString('utf8');
  // Plex image paths only; never let the proxy fetch arbitrary URLs.
  return thumb.startsWith('/library/') ? thumb : undefined;
}

function hmac(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url').slice(0, 22);
}
