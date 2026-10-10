import { activitiesEquivalent, type NowPlaying, type SourceActivity } from '../../core/activity.js';
import type { HubState } from '../../core/hub.js';
import { errorMessage, type Logger } from '../../core/log.js';
import type { DiscordActivity } from './headless.js';
import { toDiscordActivity } from './mapping.js';

/** Decides whether presence may be shown at all (e.g. only while the user is really online). */
export interface PresenceGate {
  check(): { allowed: boolean; reason?: string };
}

export const ALWAYS_ALLOW: PresenceGate = { check: () => ({ allowed: true }) };

export interface PublisherConfig {
  applicationId: string;
  /** Re-send interval; keeps the session alive (expires after ~20 min) and recovers from Invisible. */
  refreshMinutes: number;
}

/** What the publisher needs from the headless session; a seam for tests. */
export interface SessionLike {
  readonly active: boolean;
  upsert(activity: DiscordActivity): Promise<void>;
  clear(): Promise<void>;
}

export interface PublishedState {
  sourceId: string;
  activity: NowPlaying;
  discord: DiscordActivity;
  sentAt: number;
}

const DEBOUNCE_MS = 1_000;
/** Spacing between sends. Discord allows 5 calls per ~20 s; DiscordApi waits if the bucket runs out. */
const MIN_GAP_MS = 2_000;
const RETRY_MS = 30_000;

/**
 * Maps the hub's selected activity to Discord and keeps the headless session in
 * sync: it sends on change (debounced), re-sends periodically, and deletes when there's nothing to show.
 */
export class Publisher {
  private state: HubState = { activities: [], selected: null, selectionReason: 'No active source' };
  private desired: SourceActivity | null = null;
  private published: PublishedState | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Infinity;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private readonly idleWaiters = new Set<() => void>();
  private pending = false;
  private force = false;
  private lastSendAt = 0;
  private stopped = false;
  private disconnected = false;
  lastError: string | undefined;
  gateReason: string | undefined;

  constructor(
    private readonly opts: {
      config: PublisherConfig;
      session: SessionLike;
      log: Logger;
      /** False until Discord is connected; nothing is sent meanwhile. */
      ready: () => boolean;
      gate?: PresenceGate;
      /** Record confirmed display changes; never called for a failed send. */
      reportShown?: (activity: SourceActivity | null) => void;
      reportSuccess?: () => void;
    },
  ) {}

  start(): void {
    this.refreshTimer = setInterval(() => {
      if (this.published) this.kick(true);
    }, this.opts.config.refreshMinutes * 60_000);
    // Reconcile once even if nothing changes: a session left over from a previous run may need deleting.
    this.schedule(DEBOUNCE_MS);
  }

  /** Stop timers and withdraw the activity. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.refreshTimer);
    if (this.inFlight) await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    if (this.opts.ready() && this.opts.session.active) {
      await this.opts.session.clear();
      this.confirmCleared();
    }
    this.published = null;
  }

  onState(state: HubState): void {
    this.state = state;
    this.evaluate();
  }

  /** Re-evaluate now, e.g. after connecting or when the gate changes. `force` re-sends even if unchanged. */
  kick(force = false): void {
    if (force) this.force = true;
    this.evaluate();
    this.schedule(0);
  }

  current(): PublishedState | null {
    return this.published;
  }

  /** Serialize user-initiated withdrawal after any send already in progress. */
  async disconnect(clear: () => Promise<void>): Promise<void> {
    this.disconnected = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Infinity;
    this.pending = false;
    this.force = false;
    if (this.inFlight) await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    await clear();
    this.confirmCleared();
  }

  /** Only a completed new login resumes sends after Disconnect. */
  resume(): void {
    this.disconnected = false;
    this.kick(true);
  }

  /** A successful external clear (such as Disconnect) also invalidates the UI's display cache. */
  confirmCleared(): void {
    this.published = null;
    this.lastError = undefined;
    this.opts.reportShown?.(null);
  }

  /** The activity that would be shown, before gating and before it's sent. */
  candidate(): SourceActivity | null {
    return this.state.selected;
  }

  private evaluate(): void {
    const gate = this.state.paused
      ? { allowed: false, reason: 'publishing is paused' }
      : (this.opts.gate ?? ALWAYS_ALLOW).check();
    const reason = gate.allowed
      ? this.state.selected ? undefined : this.state.selectionReason === 'No active source' ? undefined : this.state.selectionReason
      : (gate.reason ?? 'blocked');
    if (reason !== this.gateReason) this.opts.log.info(reason ? `Presence hidden: ${reason}` : 'Presence allowed again');
    this.gateReason = reason;
    this.desired = gate.allowed ? this.candidate() : null;
    if (!this.force && this.matchesPublished(this.desired)) return;
    this.schedule(DEBOUNCE_MS);
  }

  private matchesPublished(target: SourceActivity | null): boolean {
    const pub = this.published;
    if (!target || !pub) return !target && !pub && !this.opts.session.active;
    return pub.sourceId === target.sourceId && activitiesEquivalent(pub.activity, target.activity);
  }

  private schedule(delay: number): void {
    if (this.stopped || this.disconnected) return;
    const at = Math.max(Date.now() + delay, this.lastSendAt + MIN_GAP_MS);
    if (this.timer && this.timerAt <= at) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = Infinity;
      void this.flush();
    }, at - Date.now());
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.disconnected || !this.opts.ready()) return;
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    const target = this.desired;
    const force = this.force;
    if (!force && this.matchesPublished(target)) return;
    if (!target && !this.opts.session.active) {
      // Nothing shown and nothing to show: no call needed.
      this.confirmCleared();
      this.force = false;
      return;
    }

    this.inFlight = true;
    this.force = false;
    this.lastSendAt = Date.now();
    try {
      if (target) {
        const discord = toDiscordActivity(target.activity, this.opts.config);
        await this.opts.session.upsert(discord);
        if (!this.published || this.published.activity.key !== target.activity.key) {
          this.opts.log.info(`Showing "${discord.name}: ${discord.details ?? ''}" from ${target.sourceId}`);
        }
        this.published = { sourceId: target.sourceId, activity: target.activity, discord, sentAt: Date.now() };
        this.opts.reportShown?.(target);
      } else {
        if (this.published) this.opts.log.info('Nothing to show; clearing presence');
        await this.opts.session.clear();
        this.confirmCleared();
      }
      this.opts.reportSuccess?.();
      this.lastError = undefined;
    } catch (err) {
      this.lastError = errorMessage(err);
      this.opts.log.error(`Publishing failed: ${this.lastError}`);
      if (force) this.force = true;
      this.schedule(RETRY_MS);
    } finally {
      this.inFlight = false;
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
    if (this.pending) {
      this.pending = false;
      this.schedule(0);
    }
  }
}
