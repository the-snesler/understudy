import { errorMessage, type Logger } from '../../core/log.js';
import { TmdbClient } from '../shared/tmdb.js';
import type { TraktWatching } from './client.js';
import { artworkIds, imageText } from './watching.js';

/**
 * Finds a public HTTPS poster for what's being watched. Trakt's own images may not be hotlinked, so
 * this uses TMDB (by the movie's or the show's ids; needs a TMDB key), then a fallback image.
 */

export interface Artwork {
  url?: string;
  source: 'tmdb' | 'fallback' | 'none';
}

export interface ArtworkOptions {
  log: Logger;
  tmdbKey?: string;
  fallback?: string;
  fetchImpl?: typeof fetch;
}

const MAX_CACHE = 200;
const FAILURE_TTL_MS = 10 * 60 * 1000;

export class ArtworkResolver {
  /** Per movie or show, so every episode of a show shares one lookup. */
  private readonly cache = new Map<string, { at: number; failed: boolean; value: Artwork }>();
  private readonly tmdb: TmdbClient | undefined;

  constructor(private readonly opts: ArtworkOptions) {
    this.tmdb = opts.tmdbKey ? new TmdbClient(opts.tmdbKey, opts.fetchImpl) : undefined;
  }

  async resolve(w: TraktWatching): Promise<Artwork> {
    const { type, ids, key } = artworkIds(w);
    const hit = this.cache.get(key);
    if (hit && (!hit.failed || Date.now() - hit.at < FAILURE_TTL_MS)) return hit.value;

    let failed = false;
    let value: Artwork | undefined;
    try {
      const poster = this.tmdb && (await this.tmdb.poster(type, ids));
      if (poster) value = { url: poster, source: 'tmdb' };
    } catch (err) {
      failed = true;
      this.opts.log.warn(`Artwork lookup failed for "${imageText(w) ?? key}": ${errorMessage(err)}`);
    }
    value ??= this.opts.fallback ? { url: this.opts.fallback, source: 'fallback' } : { source: 'none' };
    this.cache.set(key, { at: Date.now(), failed, value });
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}
