import { errorMessage, type Logger } from '../../core/log.js';
import { AlbumArtFinder } from '../shared/album-art.js';
import { USER_AGENT, type Scrobble } from './client.js';

/**
 * Finds a public HTTPS image for a track. Discord fetches images itself, so it needs a URL it can
 * load directly.
 *
 * Order: the service's own image (Last.fm), then the Cover Art Archive by MusicBrainz release (or
 * release group) id, then iTunes/Deezer album search (no key), then a fallback image.
 */

export interface Artwork {
  url?: string;
  source: 'lastfm' | 'coverartarchive' | 'itunes' | 'deezer' | 'fallback' | 'none';
}

export interface ArtworkOptions {
  log: Logger;
  /** Look up album art in iTunes and Deezer. */
  albumArt: boolean;
  fallback?: string;
  fetchImpl?: typeof fetch;
}

const MAX_CACHE = 200;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_REDIRECTS = 5;

/**
 * Cover Art Archive URLs redirect (307) to archive.org, which redirects (302) again to the storage
 * node holding the file, and answer 404 when there's no front cover. Follow the chain here so
 * Discord gets the final image URL, and nothing at all when there's no cover (rather than a broken
 * image).
 */
export async function coverArtUrl(fetchImpl: typeof fetch, kind: 'release' | 'release-group', mbid: string): Promise<string | undefined> {
  let url = `https://coverartarchive.org/${kind}/${mbid}/front-500`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return undefined;
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url);
      if (next.protocol !== 'https:') return undefined;
      url = next.toString();
      continue;
    }
    if (!res.ok) throw new Error(`Cover Art Archive request failed (${res.status})`);
    return url;
  }
  return undefined;
}

export class ArtworkResolver {
  private readonly cache = new Map<string, { at: number; failed: boolean; value: Artwork }>();
  private readonly fetchImpl: typeof fetch;
  private readonly albums: AlbumArtFinder;

  constructor(private readonly opts: ArtworkOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.albums = new AlbumArtFinder(this.fetchImpl);
  }

  async resolve(s: Scrobble): Promise<Artwork> {
    if (s.image) return { url: s.image, source: 'lastfm' };
    // Art belongs to the album, so tracks of one album share a lookup.
    const key = [s.releaseMbid, s.releaseGroupMbid, s.artist, s.album ?? s.track].join('\n').toLowerCase();
    const hit = this.cache.get(key);
    if (hit && (!hit.failed || Date.now() - hit.at < FAILURE_TTL_MS)) return hit.value;

    let failed = false;
    let value: Artwork;
    try {
      value = await this.lookup(s);
    } catch (err) {
      failed = true;
      this.opts.log.warn(`Artwork lookup failed for "${s.artist} - ${s.album ?? s.track}": ${errorMessage(err)}`);
      value = this.lastResort();
    }
    this.cache.set(key, { at: Date.now(), failed, value });
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private async lookup(s: Scrobble): Promise<Artwork> {
    const ids: ['release' | 'release-group', string | undefined][] = [
      ['release', s.releaseMbid],
      ['release-group', s.releaseGroupMbid],
    ];
    let caaError: unknown;
    for (const [kind, id] of ids) {
      if (!id) continue;
      try {
        const url = await coverArtUrl(this.fetchImpl, kind, id);
        if (url) return { url, source: 'coverartarchive' };
      } catch (err) {
        // The Cover Art Archive is sometimes slow or down; the album search may still find it.
        caaError = err;
      }
    }
    if (this.opts.albumArt && s.album) {
      const art = await this.albums.find(s.artist, s.album);
      if (art) return art;
    }
    // Nothing found, but the archive might have had it: retry later instead of caching "none".
    if (caaError) throw caaError;
    return this.lastResort();
  }

  private lastResort(): Artwork {
    if (this.opts.fallback) return { url: this.opts.fallback, source: 'fallback' };
    return { source: 'none' };
  }
}
