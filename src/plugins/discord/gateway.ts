import { errorMessage, type Logger } from '../../core/log.js';

/**
 * A minimal Discord Gateway client, connected with the user's OAuth token (our scopes include
 * `identify` + `gateway.connect`). It does two things:
 *
 * - watches the user's sessions (which clients are connected, with what status);
 * - carries our activity as this session's presence (op 3).
 *
 * The connection counts as a real session of the user's, so its status matters: left online it
 * holds the user online and breaks Invisible. It is invisible whenever there's no activity to
 * show, and while there is one it copies the status of the user's real clients, so others see the
 * same status as without us. (Asking for invisible in IDENTIFY's `presence` would be cleaner, but
 * Discord closes OAuth connections that do, with 4000.)
 *
 * This replaces headless sessions when we know the user is on Discord: Discord's headless delete
 * endpoint answers 204 but leaves the session behind, holding the user online for minutes.
 */

export interface GatewaySession {
  session_id: string;
  status: string;
  client_info?: { client?: string; os?: string; version?: number };
  activities?: { type?: number; name?: string }[];
  active?: boolean;
}

/** The parts of the WHATWG WebSocket we use; a seam for tests. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: any) => void): void;
}

export type GatewayState = 'connecting' | 'ready' | 'reconnecting' | 'stopped' | 'failed';

/** An activity as sent in a Gateway presence update (op 3). */
export interface GatewayActivity {
  type: number;
  name: string;
  application_id?: string;
  details?: string;
  state?: string;
  status_display_type?: number;
  timestamps?: { start?: number; end?: number };
  assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string };
  buttons?: string[];
  metadata?: { button_urls?: string[] };
}

interface Presence {
  since: 0;
  activities: GatewayActivity[];
  status: string;
  afk: false;
}

export interface GatewayOptions {
  /** Current access token, and a way to refresh it after an authentication failure. */
  token: () => Promise<string>;
  refreshToken: () => Promise<string>;
  log: Logger;
  /** Called whenever the session list or connection state changes. */
  onChange: () => void;
  /**
   * Session ids of our earlier connections (e.g. from before a restart). Discord keeps a dropped
   * connection's session for a few minutes; it is ours, not one of the user's clients.
   */
  previousSessionIds?: () => string[];
  /** Called with each new session id, so it can be remembered across restarts. */
  onSessionId?: (id: string) => void;
  url?: string;
  createSocket?: (url: string) => SocketLike;
  /** For tests. */
  random?: () => number;
}

const DEFAULT_URL = process.env.DISCORD_GATEWAY_URL || 'wss://gateway.discord.gg/?v=10&encoding=json';
const OPEN = 1;
const INVISIBLE: Presence = { since: 0, activities: [], status: 'invisible', afk: false };
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** How long the last known session list stays trustworthy while reconnecting. */
const STALE_GRACE_MS = 2 * 60_000;
/** Minimum spacing between presence updates (Discord rate-limits op 3). */
const PRESENCE_GAP_MS = 2_000;
/** Minimum spacing between corrections when Discord reports a different status than we sent. */
const CORRECTION_GAP_MS = 15_000;
/** Which real-client status to copy when they differ: dnd is account-wide; idle only if all are. */
const STATUS_ORDER = ['dnd', 'online', 'idle'];

/** Close codes after which retrying can't help. */
const FATAL = new Map<number, string>([
  [4010, 'invalid shard'],
  [4011, 'sharding required'],
  [4012, 'invalid API version'],
  [4013, 'invalid intents'],
  [4014, 'disallowed intents'],
]);
/** Close codes after which the session can't be resumed. */
const NO_RESUME = new Set([4004, 4007, 4009]);

export class DiscordGateway {
  state: GatewayState = 'stopped';
  /** Why the last connection failed, if it did. */
  lastError: string | undefined;
  /** Every session of the user's, including ours, as last reported by Discord. */
  sessions: GatewaySession[] = [];
  /** Our own session id. */
  sessionId: string | undefined;

  private socket: SocketLike | undefined;
  private seq: number | null = null;
  private resumeUrl: string | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private firstBeat: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private acked = true;
  private attempt = 0;
  private hasInfo = false;
  private disconnectedAt = 0;
  private lastSummary = '';
  /** The activity to show, or null to be invisible. */
  private activity: GatewayActivity | null = null;
  /** Sends on the current connection, once it's READY or RESUMED. */
  private sendFn: ((op: number, d: unknown) => void) | undefined;
  private sentPresence: Presence | undefined;
  private sentJson = '';
  private lastPresenceAt = 0;
  private lastCorrectionAt = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly random: () => number;

  constructor(private readonly opts: GatewayOptions) {
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.random = opts.random ?? Math.random;
  }

  /**
   * Whether `sessions` can be trusted: we're connected and have had a session list, or we're
   * briefly reconnecting (Discord asks clients to do this routinely) and the list is recent.
   */
  get informed(): boolean {
    if (!this.hasInfo) return false;
    if (this.state === 'ready') return true;
    return this.state === 'reconnecting' && Date.now() - this.disconnectedAt < STALE_GRACE_MS;
  }

  /** Whether an activity is set (it's shown once connected, with the user's real status). */
  get showing(): boolean {
    return this.activity !== null;
  }

  /** The presence last sent to Discord on this connection. */
  get presence(): Presence | undefined {
    return this.sentPresence;
  }

  /** Our current and earlier session ids. */
  get ownSessionIds(): ReadonlySet<string> {
    const ids = new Set(this.opts.previousSessionIds?.() ?? []);
    if (this.sessionId) ids.add(this.sessionId);
    return ids;
  }

  /** Show an activity on this session, or pass null to be invisible again. */
  setActivity(activity: GatewayActivity | null): void {
    this.activity = activity;
    this.syncPresence();
  }

  start(): void {
    if (this.state !== 'stopped' && this.state !== 'failed') return;
    this.attempt = 0;
    this.lastError = undefined;
    void this.connect();
  }

  stop(): void {
    this.state = 'stopped';
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    // 1000 ends the session immediately, rather than leaving it to time out.
    if (this.socket && this.socket.readyState === OPEN) this.socket.close(1000, 'stopping');
    this.socket = undefined;
    this.resetSession();
    this.forgetSessions();
    this.opts.onChange();
  }

  /** Forget how to resume; the next connection identifies from scratch. */
  private resetSession(): void {
    this.sessionId = undefined;
    this.seq = null;
    this.resumeUrl = undefined;
  }

  private forgetSessions(): void {
    this.sessions = [];
    this.hasInfo = false;
  }

  private async connect(): Promise<void> {
    this.state = this.attempt === 0 && !this.sessionId ? 'connecting' : 'reconnecting';
    this.opts.onChange();
    let token: string;
    try {
      token = await this.opts.token();
    } catch (err) {
      return this.fail(`No Discord token: ${errorMessage(err)}`);
    }
    // stop() may have run while we awaited the token.
    if ((this.state as GatewayState) === 'stopped') return;

    const resuming = !!(this.sessionId && this.resumeUrl);
    const base = resuming ? this.resumeUrl! : (this.opts.url ?? DEFAULT_URL);
    const url = resuming ? `${base.replace(/\/+$/, '')}/?v=10&encoding=json` : base;
    const socket = this.createSocket(url);
    this.socket = socket;
    const current = () => this.socket === socket;
    const send = (op: number, d: unknown) => {
      if (current() && socket.readyState === OPEN) socket.send(JSON.stringify({ op, d }));
    };

    socket.addEventListener('message', (ev: { data: unknown }) => {
      if (!current()) return;
      let msg: { op: number; d: any; s?: number | null; t?: string | null };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8'));
      } catch {
        return;
      }
      if (typeof msg.s === 'number') this.seq = msg.s;
      switch (msg.op) {
        case 10: {
          this.startHeartbeat(msg.d.heartbeat_interval, () => send(1, this.seq), () => socket.close(4000, 'zombied'));
          if (resuming) send(6, { token: `Bearer ${token}`, session_id: this.sessionId, seq: this.seq });
          else
            send(2, {
              token: `Bearer ${token}`,
              properties: { os: process.platform, browser: 'server-rpc', device: 'server-rpc' },
            });
          break;
        }
        case 11:
          this.acked = true;
          break;
        case 1:
          send(1, this.seq);
          break;
        case 7: // Discord asks us to reconnect (and resume).
          socket.close(4000, 'reconnect requested');
          break;
        case 9: {
          // Invalid session: resumable if d is true; otherwise start over.
          if (!msg.d) this.resetSession();
          socket.close(4000, 'invalid session');
          break;
        }
        case 0:
          this.onDispatch(msg.t ?? '', msg.d, (op, d) => send(op, d));
          break;
      }
    });

    socket.addEventListener('close', (ev: { code: number; reason?: string }) => {
      if (!current()) return;
      this.socket = undefined;
      this.sendFn = undefined;
      this.stopHeartbeat();
      void this.onClose(ev.code, ev.reason ?? '');
    });
    socket.addEventListener('error', () => {
      // A 'close' event follows; handle it there.
    });
  }

  private onDispatch(t: string, d: any, send: (op: number, d: unknown) => void): void {
    switch (t) {
      case 'READY':
        this.sessionId = d.session_id;
        this.opts.onSessionId?.(d.session_id);
        this.resumeUrl = d.resume_gateway_url;
        this.sessions = Array.isArray(d.sessions) ? d.sessions : [];
        this.hasInfo = Array.isArray(d.sessions);
        this.ready(send);
        this.logSessions();
        if (!this.hasInfo) this.opts.log.warn('Discord did not include session info in READY; waiting for SESSIONS_REPLACE');
        break;
      case 'RESUMED':
        this.ready(send);
        break;
      case 'SESSIONS_REPLACE':
        if (Array.isArray(d)) {
          this.sessions = d;
          this.hasInfo = true;
          this.logSessions();
          this.syncPresence();
          this.correctPresence();
          this.opts.onChange();
        }
        break;
    }
  }

  /** The presence we want Discord to have for this session right now. */
  private desiredPresence(): Presence {
    if (!this.activity) return INVISIBLE;
    const statuses = realSessions(this.sessions, this.ownSessionIds).map((s) => s.status);
    const status = STATUS_ORDER.find((st) => statuses.includes(st));
    // Nobody is on Discord: showing anything would make the user appear online.
    if (!status) return INVISIBLE;
    return { since: 0, activities: [this.activity], status, afk: false };
  }

  /** Send our presence if it changed, at most once per PRESENCE_GAP_MS. */
  private syncPresence(force = false): void {
    if (this.state !== 'ready' || !this.sendFn) return;
    const presence = this.desiredPresence();
    const json = JSON.stringify(presence);
    if (!force && json === this.sentJson) return;
    const wait = this.lastPresenceAt + PRESENCE_GAP_MS - Date.now();
    if (wait > 0) {
      this.presenceTimer ??= setTimeout(() => {
        this.presenceTimer = undefined;
        this.syncPresence(force);
      }, wait);
      return;
    }
    this.lastPresenceAt = Date.now();
    this.sentPresence = presence;
    this.sentJson = json;
    this.sendFn(3, presence);
  }

  /** If Discord reports our session with a different status than we sent, send it again. */
  private correctPresence(): void {
    const own = this.sessions.find((s) => s.session_id === this.sessionId);
    if (!own || !this.sentPresence || own.status === this.sentPresence.status) return;
    if (Date.now() - this.lastCorrectionAt < CORRECTION_GAP_MS) return;
    this.lastCorrectionAt = Date.now();
    this.opts.log.warn(`Discord reports our Gateway session as "${own.status}", expected "${this.sentPresence.status}"; re-sending`);
    this.syncPresence(true);
  }

  /** Log the session list when it changes, e.g. "ours=invisible, headless=online, desktop/osx=online". */
  private logSessions(): void {
    const summary = this.sessions
      .map((s) => {
        const who =
          s.session_id === this.sessionId
            ? 'ours'
            : this.ownSessionIds.has(s.session_id)
              ? 'ours (earlier)'
              : s.session_id.startsWith('h:')
                ? 'headless'
                : s.session_id === 'all'
                  ? 'all'
                  : `${s.client_info?.client ?? '?'}/${s.client_info?.os ?? '?'}`;
        return `${who}=${s.status}`;
      })
      .join(', ');
    if (summary === this.lastSummary) return;
    this.lastSummary = summary;
    this.opts.log.info(`Sessions: ${summary || 'none'}`);
  }

  private ready(send: (op: number, d: unknown) => void): void {
    const wasReconnect = this.attempt > 0;
    this.state = 'ready';
    this.attempt = 0;
    this.lastError = undefined;
    // A new or resumed connection: (re)send our presence straight away.
    this.sendFn = send;
    this.lastPresenceAt = 0;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    this.syncPresence(true);
    if (wasReconnect) this.opts.log.info('Reconnected to the Discord Gateway');
    this.opts.onChange();
  }

  private async onClose(code: number, reason: string): Promise<void> {
    if (this.state === 'stopped') return;
    const fatal = FATAL.get(code);
    if (fatal) return this.fail(`Discord closed the Gateway connection: ${fatal} (${code})`);
    if (NO_RESUME.has(code)) this.resetSession();
    if (code === 4004) {
      // Authentication failed: the access token may have expired early.
      try {
        await this.opts.refreshToken();
      } catch (err) {
        return this.fail(`Gateway authentication failed and the token could not be refreshed: ${errorMessage(err)}`);
      }
    }
    if (this.state === 'ready') this.disconnectedAt = Date.now();
    this.lastError = `Connection closed (${code}${reason ? `: ${reason}` : ''})`;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]! * (0.75 + this.random() * 0.5);
    this.attempt++;
    if (this.attempt === 1 || this.attempt % 5 === 0) {
      this.opts.log.warn(`Gateway ${this.lastError}; reconnecting in ${Math.round(delay / 1000)}s`);
    }
    this.state = 'reconnecting';
    this.opts.onChange();
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private fail(message: string): void {
    this.state = 'failed';
    this.lastError = message;
    this.resetSession();
    this.forgetSessions();
    this.opts.log.error(message);
    this.opts.onChange();
  }

  private startHeartbeat(interval: number, beat: () => void, zombie: () => void): void {
    this.stopHeartbeat();
    this.acked = true;
    const tick = () => {
      if (!this.acked) {
        this.opts.log.warn('Gateway heartbeat not acknowledged; reconnecting');
        zombie();
        return;
      }
      this.acked = false;
      beat();
    };
    this.firstBeat = setTimeout(() => {
      tick();
      this.heartbeat = setInterval(tick, interval);
    }, Math.floor(interval * this.random()));
  }

  private stopHeartbeat(): void {
    clearTimeout(this.firstBeat);
    clearInterval(this.heartbeat);
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
  }
}

// ---- the gate --------------------------------------------------------------------------------

export type OnlineStatus = 'online' | 'idle' | 'dnd';

/** Sessions belonging to the user's real clients: not ours (now or earlier), not headless, not the aggregate. */
export function realSessions(sessions: GatewaySession[], own: string | undefined | ReadonlySet<string>): GatewaySession[] {
  const ours = (id: string) => (typeof own === 'string' || own === undefined ? id === own : own.has(id));
  return sessions.filter((s) => !ours(s.session_id) && s.session_id !== 'all' && !s.session_id.startsWith('h:'));
}

export function onlineCheck(
  sessions: GatewaySession[],
  own: string | undefined | ReadonlySet<string>,
  statuses: OnlineStatus[],
): { allowed: boolean; reason?: string } {
  const real = realSessions(sessions, own);
  if (real.some((s) => (statuses as string[]).includes(s.status))) return { allowed: true };
  if (!real.length) return { allowed: false, reason: "you're not signed in to Discord anywhere" };
  const shown = [...new Set(real.map((s) => s.status))].join('/');
  return { allowed: false, reason: `your Discord status is ${shown}` };
}
