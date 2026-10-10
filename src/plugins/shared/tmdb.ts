import type { ActivityLink } from '../../core/activity.js';

/**
 * TMDB lookups for movie and show posters. Discord fetches images itself, so sources whose own
 * artwork is private (Plex, Jellyfin) or missing (Trakt) use TMDB's public image CDN instead.
 */

export interface ExternalIds {
  imdb?: string;
  tmdb?: string;
  tvdb?: string;
}

export type TmdbType = 'movie' | 'tv';

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMAGES = 'https://image.tmdb.org/t/p/w500';

export class TmdbClient {
  private readonly fetchImpl: typeof fetch;

  /** `key` is a v3 API key or a v4 read access token. */
  constructor(
    private readonly key: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /** A poster URL for the item, by TMDB id first, then IMDb or TVDB id. */
  async poster(type: TmdbType, ids: ExternalIds): Promise<string | undefined> {
    type Item = { poster_path?: string | null };
    if (ids.tmdb) {
      const item = await this.get<Item>(`/${type}/${ids.tmdb}`);
      if (item.poster_path) return TMDB_IMAGES + item.poster_path;
    }
    const lookups: [string | undefined, string][] = [
      [ids.imdb, 'imdb_id'],
      [type === 'tv' ? ids.tvdb : undefined, 'tvdb_id'],
    ];
    for (const [id, source] of lookups) {
      if (!id) continue;
      const found = await this.get<{ movie_results?: Item[]; tv_results?: Item[] }>(`/find/${id}`, {
        external_source: source,
      });
      const item = (type === 'movie' ? found.movie_results : found.tv_results)?.[0];
      if (item?.poster_path) return TMDB_IMAGES + item.poster_path;
    }
    return undefined;
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${TMDB_API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: 'application/json' };
    // A v4 "read access token" is a JWT; a v3 API key is a short hex string.
    if (this.key.startsWith('eyJ')) headers.Authorization = `Bearer ${this.key}`;
    else url.searchParams.set('api_key', this.key);
    const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return {} as T;
    if (!res.ok) throw new Error(`TMDB ${path.split('/')[1]} request failed (${res.status})`);
    return (await res.json()) as T;
  }
}

/** An IMDb button, or a TMDB one if there's no IMDb id. */
export function externalLinks(type: TmdbType, ids: ExternalIds): ActivityLink[] {
  if (ids.imdb) return [{ label: 'IMDb', url: `https://www.imdb.com/title/${ids.imdb}/` }];
  if (ids.tmdb) return [{ label: 'TMDB', url: `https://www.themoviedb.org/${type}/${ids.tmdb}` }];
  return [];
}
