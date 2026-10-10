/**
 * Minimal Jellyfin/Emby API client. Both servers share the Sessions and Items APIs (Jellyfin is a
 * fork of Emby); they differ in where the API lives and how the token is sent. Only the fields we
 * use are typed.
 */

export type ServerType = 'Jellyfin' | 'Emby';

export interface JellyfinItem {
  Id?: string;
  Name?: string;
  /** Movie | Episode | Audio | MusicVideo | AudioBook | TvChannel | Video | ... */
  Type?: string;
  /** Video | Audio | Photo | Book */
  MediaType?: string;
  ProductionYear?: number;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  SeriesId?: string;
  SeriesName?: string;
  Album?: string;
  AlbumId?: string;
  AlbumArtist?: string;
  Artists?: string[];
  Genres?: string[];
  Studios?: { Name?: string }[];
  OfficialRating?: string;
  /** 100 ns ticks. */
  RunTimeTicks?: number;
  /** e.g. `{ Tmdb: '603', Imdb: 'tt0133093' }`. */
  ProviderIds?: Record<string, string>;
  ImageTags?: Record<string, string>;
  SeriesPrimaryImageTag?: string;
  AlbumPrimaryImageTag?: string;
}

export interface JellyfinSession {
  Id?: string;
  UserId?: string;
  UserName?: string;
  /** App name, e.g. "Jellyfin Web" or "Finamp". */
  Client?: string;
  DeviceName?: string;
  DeviceId?: string;
  LastActivityDate?: string;
  LastPlaybackCheckIn?: string;
  NowPlayingItem?: JellyfinItem;
  PlayState?: { PositionTicks?: number; IsPaused?: boolean };
}

export class JellyfinError extends Error {}

/** Sessions idle for longer than this are left out of `/Sessions`, like Jellyfin's own dashboard. */
const ACTIVE_WITHIN_SECONDS = 960;

export class JellyfinClient {
  private readonly base: string;

  constructor(
    private readonly server: ServerType,
    url: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    // Emby serves its API under /emby; Jellyfin dropped that prefix.
    this.base = url.replace(/\/+$/, '') + (server === 'Emby' ? '/emby' : '');
  }

  /**
   * Jellyfin 10.11+ can turn off the legacy `X-Emby-Token` header (and later releases do by
   * default), so it gets the `Authorization: MediaBrowser` scheme. Emby documents `X-Emby-Token`.
   * Never log these: they hold the API key.
   */
  private headers(): Record<string, string> {
    const auth: Record<string, string> =
      this.server === 'Emby' ? { 'X-Emby-Token': this.apiKey } : { Authorization: `MediaBrowser Token="${this.apiKey}"` };
    return { Accept: 'application/json', ...auth };
  }

  private async request(path: string, params: Record<string, string> = {}): Promise<Response> {
    const u = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    try {
      return await this.fetchImpl(u.toString(), { headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new JellyfinError(`Could not reach ${this.server} at ${this.base}: ${(err as Error).message}`);
    }
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const res = await this.request(path, params);
    if (res.status === 401 || res.status === 403) throw new JellyfinError(`${this.server} rejected the API key`);
    if (!res.ok) throw new JellyfinError(`${this.server} ${path} failed (${res.status})`);
    const body = (await res.json().catch(() => undefined)) as T | undefined;
    if (body === undefined) throw new JellyfinError(`${this.server} ${path} returned something other than JSON; check the URL`);
    return body;
  }

  async sessions(): Promise<JellyfinSession[]> {
    const data = await this.get<unknown>('/Sessions', { activeWithinSeconds: String(ACTIVE_WITHIN_SECONDS) });
    if (!Array.isArray(data)) throw new JellyfinError(`${this.server} /Sessions returned an unexpected response; check the URL`);
    return data as JellyfinSession[];
  }

  /** One item with its provider ids, as seen by `userId` (needed by Emby, accepted by Jellyfin). */
  async item(id: string, userId?: string): Promise<JellyfinItem | undefined> {
    const params: Record<string, string> = { Ids: id, Fields: 'ProviderIds' };
    if (userId) params.UserId = userId;
    const data = await this.get<{ Items?: JellyfinItem[] }>('/Items', params);
    return data.Items?.[0];
  }

  /** Fetch an item's primary image (server side; the key stays here). */
  async image(itemId: string, opts: { width: number; height: number }): Promise<Response> {
    const res = await this.request(`/Items/${encodeURIComponent(itemId)}/Images/Primary`, {
      maxWidth: String(opts.width),
      maxHeight: String(opts.height),
      quality: '90',
    });
    if (!res.ok) throw new JellyfinError(`${this.server} image request failed (${res.status})`);
    return res;
  }
}
