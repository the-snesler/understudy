import type { Hub } from './hub.js';
import type { Logger } from './log.js';
import type { ScopedState } from './store.js';

export interface PauseInfo {
  paused: boolean;
  /** Epoch ms when it started. */
  since?: number;
  /** Epoch ms when it ends by itself; undefined while paused = until resumed. */
  until?: number;
}

interface Stored {
  pause?: { since: number; until: number | null };
}

/** Longest timed pause; longer is "until resumed". (setTimeout can't wait more than ~24 days.) */
const MAX_PAUSE_MINUTES = 7 * 24 * 60;

/**
 * App-wide controls that aren't any one plugin's: currently "pause publishing". The pause is
 * persisted, ends by itself when timed, and reaches outputs through the hub.
 */
export class Controls {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: ScopedState<Stored>,
    private readonly hub: Hub,
    private readonly log: Logger,
  ) {}

  /** Restore a pause saved before a restart. */
  start(): void {
    const p = this.store.get()?.pause;
    if (p && p.until !== null && p.until <= Date.now()) this.persist(undefined);
    this.apply();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  pauseInfo(): PauseInfo {
    const p = this.store.get()?.pause;
    if (!p || (p.until !== null && p.until <= Date.now())) return { paused: false };
    return { paused: true, since: p.since, until: p.until ?? undefined };
  }

  /** Pause publishing for `minutes`, or until resumed if omitted. */
  async pause(minutes?: number): Promise<PauseInfo> {
    const timed = minutes !== undefined && Number.isFinite(minutes) && minutes > 0 && minutes <= MAX_PAUSE_MINUTES;
    const until = timed ? Date.now() + minutes * 60_000 : null;
    await this.write({ since: this.pauseInfo().since ?? Date.now(), until });
    this.log.info(until ? `Publishing paused until ${new Date(until).toLocaleString()}` : 'Publishing paused until resumed');
    this.apply();
    return this.pauseInfo();
  }

  async resume(): Promise<PauseInfo> {
    if (!this.pauseInfo().paused) return this.pauseInfo();
    await this.write(undefined);
    this.log.info('Publishing resumed');
    this.apply();
    return this.pauseInfo();
  }

  private write(pause: Stored['pause']): Promise<void> {
    return this.store.set(pause ? { ...this.store.get(), pause } : {});
  }

  /** Write in the background, logging failures. */
  private persist(pause: Stored['pause']): void {
    this.write(pause).catch((err: unknown) => this.log.error(`Could not save the pause: ${(err as Error).message}`));
  }

  private apply(): void {
    clearTimeout(this.timer);
    const info = this.pauseInfo();
    this.hub.setPaused(info.paused);
    if (info.until) {
      this.timer = setTimeout(() => {
        this.log.info('Pause ended; publishing resumed');
        // pauseInfo() already treats the expired pause as over; tell outputs now, persist after.
        this.apply();
        this.persist(undefined);
      }, info.until - Date.now());
    }
  }
}
