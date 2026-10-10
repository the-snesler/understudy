/**
 * Minimal Last.fm and ListenBrainz clients: just "what is this user playing now". Neither service
 * says when the track started, and both keep reporting it for a while after playback stops; the
 * plugin deals with that (see track.ts).
 */

export type Service = 'Last.fm' | 'ListenBrainz';

/** A now-playing track, in the shape both services share. */
export interface Scrobble {
  track: string;
  artist: string;
  album?: string;
  /** Track length, if the service (or Last.fm's track.getInfo) knows it. */
  durationMs?: number;
  /** MusicBrainz ids, if known. Validated UUIDs only. */
  recordingMbid?: string;
  releaseMbid?: string;
  releaseGroupMbid?: string;
  /** Artwork the service itself provided (Last.fm only). */
  image?: string;
  /** The track's page on the service (Last.fm only). */
  url?: string;
  /** The player or scrobbler that reported it, e.g. "Plexamp" (ListenBrainz only). */
  player?: string;
}

export interface ScrobbleClient {
  readonly service: Service;
  nowPlaying(): Promise<Scrobble | undefined>;
  /** How long to wait before the next request, if the service asked us to slow down. */
  waitMs(): number;
}

export class ScrobblerError extends Error {
  constructor(
    message: string,
    /** The service is rate limiting us; back off. */
    readonly rateLimited = false,
    /** How long the service asked us to wait, if it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export const USER_AGENT = 'Understudy (+https://github.com/the-snesler/understudy)';

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mbid = (v: unknown): string | undefined => (typeof v === 'string' && MBID.test(v.trim()) ? v.trim().toLowerCase() : undefined);

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const MAX_CACHE = 200;

// ---- Last.fm -----------------------------------------------------------------------------------

/** Last.fm's text fields are either plain strings or `{ "#text": … }` objects. */
type LastfmText = string | { '#text'?: string; mbid?: string; name?: string };

export interface LastfmTrack {
  name?: string;
  mbid?: string;
  url?: string;
  artist?: LastfmText;
  album?: LastfmText;
  image?: { size?: string; '#text'?: string }[];
  '@attr'?: { nowplaying?: string };
  date?: { uts?: string };
}

/** Last.fm's "no artwork" star. It's served as a real image, so it has to be recognised by name. */
const LASTFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';
const IMAGE_SIZES = ['extralarge', 'mega', 'large', 'medium', 'small'];

const lastfmText = (v: LastfmText | undefined): string | undefined => (typeof v === 'string' ? str(v) : str(v?.['#text']) ?? str(v?.name));

/** The largest real image in a Last.fm image list, or undefined for none/the placeholder. */
export function lastfmImage(images: LastfmTrack['image']): string | undefined {
  const usable = (images ?? []).filter((i) => {
    const url = i['#text'];
    return url?.startsWith('https://') && !url.includes(LASTFM_PLACEHOLDER);
  });
  const rank = (size?: string) => {
    const i = IMAGE_SIZES.indexOf(size ?? '');
    return i < 0 ? IMAGE_SIZES.length : i;
  };
  return usable.sort((a, b) => rank(a.size) - rank(b.size))[0]?.['#text'];
}

export function fromLastfm(t: LastfmTrack): Scrobble | undefined {
  const track = str(t.name);
  const artist = lastfmText(t.artist);
  if (!track || !artist) return undefined;
  const s: Scrobble = { track, artist };
  const album = lastfmText(t.album);
  if (album) s.album = album;
  // Last.fm's ids are MusicBrainz ids: the track's is a recording, the album's a release.
  const recording = mbid(t.mbid);
  const release = mbid(typeof t.album === 'object' ? t.album.mbid : undefined);
  if (recording) s.recordingMbid = recording;
  if (release) s.releaseMbid = release;
  const image = lastfmImage(t.image);
  if (image) s.image = image;
  if (t.url?.startsWith('https://')) s.url = t.url;
  return s;
}

export class LastfmClient implements ScrobbleClient {
  readonly service = 'Last.fm';
  private readonly lengths = new Map<string, number | undefined>();

  constructor(
    private readonly user: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  /** Calls an API method. The URL contains the API key: never log or expose it. */
  async call<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = new URL('https://ws.audioscrobbler.com/2.0/');
    url.searchParams.set('method', method);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('format', 'json');
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new ScrobblerError(`Could not reach Last.fm: ${(err as Error).message}`);
    }
    // Errors come as `{ error, message }`, sometimes with HTTP 200, sometimes with 4xx/5xx.
    const body = (await res.json().catch(() => undefined)) as (T & { error?: number; message?: string }) | undefined;
    const code = typeof body?.error === 'number' ? body.error : undefined;
    if (code === 29 || res.status === 429) throw new ScrobblerError('Last.fm rate limit exceeded', true);
    if (code === 10 || code === 26) throw new ScrobblerError('Last.fm rejected the API key');
    if (code === 17) throw new ScrobblerError(`Last.fm user "${this.user}" hides their recent listening (Last.fm → Settings → Privacy)`);
    if (code !== undefined) throw new ScrobblerError(`Last.fm ${method} failed: ${body?.message ?? `error ${code}`}`);
    if (!res.ok || !body) throw new ScrobblerError(`Last.fm ${method} failed (${res.status})`);
    return body;
  }

  async nowPlaying(): Promise<Scrobble | undefined> {
    const body = await this.call<{ recenttracks?: { track?: LastfmTrack | LastfmTrack[] } }>('user.getrecenttracks', {
      user: this.user,
      limit: '1',
    });
    // With limit=1 a now-playing track comes *with* the last scrobble, as an array; a lone track
    // may come as an object.
    const raw = body.recenttracks?.track;
    const tracks = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const playing = tracks.find((t) => t['@attr']?.nowplaying === 'true');
    return playing && fromLastfm(playing);
  }

  /** The track's length from track.getInfo, cached per track. Unknown (0 on Last.fm) is undefined. */
  async trackLength(artist: string, track: string): Promise<number | undefined> {
    const key = `${artist}\n${track}`.toLowerCase();
    if (this.lengths.has(key)) return this.lengths.get(key);
    let length: number | undefined;
    try {
      const body = await this.call<{ track?: { duration?: string | number } }>('track.getInfo', { artist, track });
      const ms = num(body.track?.duration);
      length = ms && ms > 0 ? ms : undefined;
    } catch (err) {
      // Not found is common and final; rate limits and outages aren't worth retrying for a bar.
      if (err instanceof ScrobblerError && err.rateLimited) throw err;
    }
    this.lengths.set(key, length);
    if (this.lengths.size > MAX_CACHE) this.lengths.delete(this.lengths.keys().next().value!);
    return length;
  }

  waitMs(): number {
    return 0;
  }
}

// ---- ListenBrainz ------------------------------------------------------------------------------

export interface ListenBrainzListen {
  playing_now?: boolean;
  track_metadata?: {
    track_name?: string;
    artist_name?: string;
    release_name?: string;
    additional_info?: Record<string, unknown>;
    mbid_mapping?: Record<string, unknown>;
  };
}

export function fromListenBrainz(l: ListenBrainzListen): Scrobble | undefined {
  const m = l.track_metadata;
  const track = str(m?.track_name);
  const artist = str(m?.artist_name);
  if (!m || !track || !artist) return undefined;
  const info = m.additional_info ?? {};
  const mapping = m.mbid_mapping ?? {};
  const s: Scrobble = { track, artist };
  const album = str(m.release_name);
  if (album) s.album = album;
  const ms = num(info.duration_ms) ?? (num(info.duration) !== undefined ? num(info.duration)! * 1000 : undefined);
  if (ms && ms > 0) s.durationMs = ms;
  const recording = mbid(info.recording_mbid) ?? mbid(mapping.recording_mbid);
  const release = mbid(info.release_mbid) ?? mbid(mapping.release_mbid) ?? mbid(mapping.caa_release_mbid);
  const group = mbid(info.release_group_mbid);
  if (recording) s.recordingMbid = recording;
  if (release) s.releaseMbid = release;
  if (group) s.releaseGroupMbid = group;
  const player = str(info.media_player) ?? str(info.submission_client) ?? str(info.music_service_name);
  if (player) s.player = player;
  return s;
}

export class ListenBrainzClient implements ScrobbleClient {
  readonly service = 'ListenBrainz';
  private notBefore = 0;

  constructor(
    private readonly user: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly base = 'https://api.listenbrainz.org',
  ) {}

  private async request<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (this.token) headers.Authorization = `Token ${this.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new ScrobblerError(`Could not reach ListenBrainz: ${(err as Error).message}`);
    }
    // Every response says how many requests are left in the current window.
    const resetMs = (num(res.headers.get('x-ratelimit-reset-in')) ?? 0) * 1000;
    if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') this.notBefore = Date.now() + (resetMs || 10_000);
    if (res.status === 429) throw new ScrobblerError('ListenBrainz rate limit exceeded', true, resetMs || undefined);
    const body = (await res.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
    if (res.status === 401) throw new ScrobblerError('ListenBrainz rejected the token');
    if (res.status === 404) throw new ScrobblerError(`ListenBrainz user "${this.user}" not found`);
    if (!res.ok || !body) throw new ScrobblerError(`ListenBrainz request failed (${res.status})${body?.error ? `: ${body.error}` : ''}`);
    return body;
  }

  async nowPlaying(): Promise<Scrobble | undefined> {
    const body = await this.request<{ payload?: { listens?: ListenBrainzListen[] } }>(`/1/user/${encodeURIComponent(this.user)}/playing-now`);
    const listen = body.payload?.listens?.[0];
    return listen && fromListenBrainz(listen);
  }

  /** Whether the token is valid. playing-now itself ignores a bad token, so check it separately. */
  async validateToken(): Promise<{ valid: boolean; user?: string }> {
    const body = await this.request<{ valid?: boolean; user_name?: string }>('/1/validate-token');
    return { valid: body.valid === true, user: body.user_name };
  }

  waitMs(): number {
    return Math.max(0, this.notBefore - Date.now());
  }
}
