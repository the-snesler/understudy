/**
 * Minimal Tautulli API v2 client. Only the fields we use are typed. Tautulli returns most numbers as
 * strings, so callers parse them.
 */

export interface TautulliSession {
  session_key?: string;
  rating_key?: string;
  parent_rating_key?: string;
  grandparent_rating_key?: string;
  media_type?: string; // movie | episode | track | clip | photo | ...
  state?: string; // playing | paused | buffering
  title?: string;
  parent_title?: string;
  grandparent_title?: string;
  original_title?: string;
  full_title?: string;
  year?: string | number;
  media_index?: string | number;
  parent_media_index?: string | number;
  view_offset?: string | number;
  duration?: string | number;
  thumb?: string;
  parent_thumb?: string;
  grandparent_thumb?: string;
  guid?: string;
  parent_guid?: string;
  grandparent_guid?: string;
  genres?: string[];
  directors?: string[];
  studio?: string;
  live?: string | number;
  channel_title?: string;
  user?: string;
  username?: string;
  friendly_name?: string;
  player?: string;
  product?: string;
  library_name?: string;
}

export interface TautulliMetadata {
  rating_key?: string;
  guid?: string;
  guids?: string[];
}

export class TautulliError extends Error {}

export class TautulliClient {
  private readonly base: string;

  constructor(
    url: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    this.base = url.replace(/\/+$/, '');
  }

  /** The API URL for a command. Contains the API key: never log or expose it. */
  private url(cmd: string, params: Record<string, string> = {}): string {
    const u = new URL(`${this.base}/api/v2`);
    u.searchParams.set('apikey', this.apiKey);
    u.searchParams.set('cmd', cmd);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  async call<T>(cmd: string, params?: Record<string, string>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(cmd, params), { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new TautulliError(`Could not reach Tautulli at ${this.base}: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => undefined)) as
      | { response?: { result?: string; message?: string | null; data?: T } }
      | undefined;
    const failed = !res.ok || body?.response?.result !== 'success';
    if (res.status === 401 || (failed && /api ?key/i.test(body?.response?.message ?? ''))) {
      throw new TautulliError('Tautulli rejected the API key');
    }
    if (failed || !body?.response) {
      throw new TautulliError(`Tautulli ${cmd} failed (${res.status}): ${body?.response?.message ?? res.statusText}`);
    }
    return body.response.data as T;
  }

  async activity(): Promise<TautulliSession[]> {
    const data = await this.call<{ sessions?: TautulliSession[] }>('get_activity');
    return data?.sessions ?? [];
  }

  metadata(ratingKey: string): Promise<TautulliMetadata> {
    return this.call<TautulliMetadata>('get_metadata', { rating_key: ratingKey });
  }

  /** Fetch an image through Tautulli's `pms_image_proxy` (server side; the key stays here). */
  async image(img: string, opts: { width: number; height: number }): Promise<Response> {
    const res = await this.fetchImpl(
      this.url('pms_image_proxy', {
        img,
        width: String(opts.width),
        height: String(opts.height),
        img_format: 'jpg',
        fallback: 'poster',
      }),
      { signal: AbortSignal.timeout(this.timeoutMs) },
    );
    if (!res.ok) throw new TautulliError(`Tautulli image request failed (${res.status})`);
    return res;
  }
}
