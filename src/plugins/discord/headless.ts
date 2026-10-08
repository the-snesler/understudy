import { errorMessage, type Logger } from '../../core/log.js';
import { DiscordApiError, type DiscordApi } from './api.js';

/** The subset of Discord's activity object we send. Field rules are from our spike results. */
export interface DiscordActivity {
  application_id: string;
  platform: 'desktop';
  supported_platforms: ['desktop'];
  /** 0 Playing, 2 Listening, 3 Watching. */
  type: 0 | 2 | 3;
  name: string;
  details?: string;
  state?: string;
  /** 0 = show name, 1 = state, 2 = details in the short status. */
  status_display_type?: 0 | 1 | 2;
  timestamps?: { start?: string; end?: string };
  assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string };
  buttons?: { label: string; url: string }[];
}

export interface SessionTokenStore {
  load(): string | undefined;
  save(token: string | undefined): Promise<void>;
}

/** Discord's "Invalid authentication token": the session token is unknown or expired. */
const INVALID_SESSION_TOKEN = 50014;

/**
 * One headless session. Discord rotates the session token on every update, so the latest token is
 * saved after each call. Calls are strictly serialised: an update that lands after a delete would
 * bring the deleted session back.
 */
export class HeadlessSession {
  private token: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: DiscordApi,
    private readonly store: SessionTokenStore,
    private readonly log: Logger,
  ) {
    this.token = store.load();
  }

  get active(): boolean {
    return this.token !== undefined;
  }

  upsert(activity: DiscordActivity): Promise<void> {
    return this.serial(async () => {
      try {
        await this.send(activity, this.token);
      } catch (err) {
        if (!this.token || !isStaleToken(err)) throw err;
        this.log.info('Headless session expired or unknown; creating a new one');
        await this.setToken(undefined);
        await this.send(activity, undefined);
      }
    });
  }

  clear(): Promise<void> {
    return this.serial(async () => {
      const token = this.token;
      if (!token) return;
      try {
        await this.api.request('POST', '/users/@me/headless-sessions/delete', { token });
      } catch (err) {
        if (!(err instanceof DiscordApiError && (err.status === 400 || err.status === 404))) throw err;
      }
      await this.setToken(undefined);
    });
  }

  private async send(activity: DiscordActivity, token: string | undefined): Promise<void> {
    const res = await this.api.request<{ token?: string }>('POST', '/users/@me/headless-sessions', {
      activities: [activity],
      ...(token ? { token } : {}),
    });
    if (res.body?.token) await this.setToken(res.body.token);
  }

  private async setToken(token: string | undefined): Promise<void> {
    this.token = token;
    try {
      await this.store.save(token);
    } catch (err) {
      this.log.error(`Could not save headless session token: ${errorMessage(err)}`);
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function isStaleToken(err: unknown): boolean {
  return err instanceof DiscordApiError && (err.status === 404 || err.code === INVALID_SESSION_TOKEN);
}
