import type { Logger } from '../../core/log.js';

export interface TokenProvider {
  /** A valid access token, refreshed first if it's about to expire. */
  accessToken(): Promise<string>;
  /** Refresh now (after a 401), returning the new access token. */
  forceRefresh(): Promise<string>;
}

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    /** Discord's JSON error code, e.g. 50014 or 50001. */
    readonly code: number | undefined,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiOptions {
  apiBase: string;
  tokens: TokenProvider;
  log: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_429_RETRIES = 3;

/**
 * Minimal Discord REST client for user-authorised (Bearer) calls. It refreshes the token once on a
 * 401, and respects rate limits: it waits when the bucket is exhausted and retries on 429. All the
 * calls we make share one bucket, so one gate is enough.
 */
export class DiscordApi {
  private blockedUntil = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: ApiOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    let token = await this.opts.tokens.accessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const wait = this.blockedUntil - this.now();
      if (wait > 0) await this.sleep(wait);

      const res = await this.fetchImpl(`${this.opts.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      this.trackRateLimit(res);
      const text = await res.text();
      const parsed: unknown = text ? safeJson(text) : undefined;

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.opts.log.info('Discord returned 401; refreshing the access token');
        token = await this.opts.tokens.forceRefresh();
        continue;
      }
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = Number((parsed as { retry_after?: number } | undefined)?.retry_after ?? 1);
        this.opts.log.warn(`Rate limited on ${method} ${path}; retrying in ${retryAfter.toFixed(1)}s`);
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + retryAfter * 1000);
        continue;
      }
      if (!res.ok) {
        const err = parsed as { message?: string; code?: number } | undefined;
        throw new DiscordApiError(
          res.status,
          err?.code,
          parsed,
          `Discord ${method} ${path} failed (${res.status}): ${err?.message ?? res.statusText}${err?.code ? ` [${err.code}]` : ''}`,
        );
      }
      return { status: res.status, body: parsed as T };
    }
  }

  private trackRateLimit(res: Response): void {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const resetAfter = res.headers.get('x-ratelimit-reset-after');
    if (remaining === '0' && resetAfter) {
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + Number(resetAfter) * 1000);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
