import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordGateway, onlineCheck, type GatewaySession, type SocketLike } from '../src/plugins/discord/gateway.js';
import { quietLogger } from './helpers.js';

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: { op: number; d: any }[] = [];
  closed: number[] = [];
  private listeners: Record<string, ((ev: any) => void)[]> = {};
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed.push(code);
    this.readyState = 3;
    this.emit('close', { code });
  }
  addEventListener(type: string, listener: (ev: any) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, ev: unknown) {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
  /** Simulate a message from Discord. */
  receive(op: number, d: unknown, t: string | null = null, s: number | null = null) {
    this.emit('message', { data: JSON.stringify({ op, d, t, s }) });
  }
  /** Simulate Discord dropping the connection. */
  drop(code: number) {
    this.readyState = 3;
    this.emit('close', { code });
  }
  ops() {
    return this.sent.map((m) => m.op);
  }
}

const session = (id: string, status: string, client = 'desktop'): GatewaySession => ({
  session_id: id,
  status,
  client_info: { client, os: 'osx' },
});

function setup() {
  const sockets: FakeSocket[] = [];
  let refreshes = 0;
  let changes = 0;
  const gw = new DiscordGateway({
    token: async () => `token-${refreshes}`,
    refreshToken: async () => `token-${++refreshes}`,
    log: quietLogger(),
    onChange: () => void changes++,
    url: 'wss://gateway.test/?v=10&encoding=json',
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    random: () => 0.5,
  });
  const last = () => sockets.at(-1)!;
  /** Connect and complete IDENTIFY → READY with the given sessions. */
  const connect = async (sessions: GatewaySession[]) => {
    gw.start();
    await vi.advanceTimersByTimeAsync(0);
    last().receive(10, { heartbeat_interval: 40_000 });
    last().receive(0, { session_id: 'ours', resume_gateway_url: 'wss://resume.test', sessions }, 'READY', 1);
  };
  return { gw, sockets, last, connect, refreshes: () => refreshes, changes: () => changes };
}

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe('DiscordGateway', () => {
  it('identifies without a presence (Discord rejects it for OAuth), then goes invisible on READY', async () => {
    const t = setup();
    await t.connect([session('ours', 'online', 'web'), session('desk', 'online')]);
    const s = t.last();
    expect(s.url).toBe('wss://gateway.test/?v=10&encoding=json');
    expect(s.sent[0]).toMatchObject({ op: 2, d: { token: 'Bearer token-0' } });
    expect(s.sent[0]?.d.presence).toBeUndefined();
    expect(s.sent[1]).toEqual({ op: 3, d: { since: 0, activities: [], status: 'invisible', afk: false } });
    expect(t.gw.state).toBe('ready');
    expect(t.gw.informed).toBe(true);
    expect(t.gw.sessionId).toBe('ours');
  });

  it('tracks SESSIONS_REPLACE', async () => {
    const t = setup();
    await t.connect([session('ours', 'invisible', 'web')]);
    const before = t.changes();
    t.last().receive(0, [session('ours', 'invisible', 'web'), session('desk', 'dnd')], 'SESSIONS_REPLACE', 2);
    expect(t.gw.sessions.map((s) => s.status)).toEqual(['invisible', 'dnd']);
    expect(t.changes()).toBeGreaterThan(before);
  });

  it('carries the activity with the real clients\' status, and goes invisible without one', async () => {
    const t = setup();
    await t.connect([session('ours', 'online', 'web'), session('desk', 'online')]);
    const s = t.last();
    const presences = () => s.sent.filter((m) => m.op === 3).map((m) => `${m.d.status}:${m.d.activities.length}`);
    expect(presences()).toEqual(['invisible:0']);

    await vi.advanceTimersByTimeAsync(2_000);
    t.gw.setActivity({ type: 3, name: 'Plex', details: 'The Matrix' });
    expect(presences()).toEqual(['invisible:0', 'online:1']);
    expect(s.sent.at(-1)?.d.activities[0]).toEqual({ type: 3, name: 'Plex', details: 'The Matrix' });

    // The desktop goes idle: copy it (after the 2 s spacing).
    s.receive(0, [session('ours', 'online', 'web'), session('desk', 'idle')], 'SESSIONS_REPLACE', 2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(presences().at(-1)).toBe('idle:1');

    // dnd on any client wins; then the client closes: invisible.
    s.receive(0, [session('ours', 'idle', 'web'), session('desk', 'idle'), session('phone', 'dnd', 'mobile')], 'SESSIONS_REPLACE', 3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(presences().at(-1)).toBe('dnd:1');
    s.receive(0, [session('ours', 'dnd', 'web')], 'SESSIONS_REPLACE', 4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(presences().at(-1)).toBe('invisible:0');

    // Clearing while already invisible sends nothing new.
    const count = presences().length;
    t.gw.setActivity(null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(presences()).toHaveLength(count);
  });

  it('coalesces quick changes into one update', async () => {
    const t = setup();
    await t.connect([session('desk', 'online')]);
    const s = t.last();
    t.gw.setActivity({ type: 3, name: 'Plex', details: 'one' });
    t.gw.setActivity({ type: 3, name: 'Plex', details: 'two' });
    t.gw.setActivity({ type: 3, name: 'Plex', details: 'three' });
    await vi.advanceTimersByTimeAsync(2_000);
    const op3 = s.sent.filter((m) => m.op === 3);
    expect(op3.map((m) => m.d.activities[0]?.details ?? null)).toEqual([null, 'three']);
  });

  it('re-sends when Discord reports a different status for our session, at most every 15 s', async () => {
    const t = setup();
    await t.connect([session('ours', 'invisible', 'web')]);
    const s = t.last();
    const op3s = () => s.sent.filter((m) => m.op === 3).length;
    await vi.advanceTimersByTimeAsync(2_000);
    s.receive(0, [session('ours', 'online', 'web')], 'SESSIONS_REPLACE', 2);
    expect(op3s()).toBe(2);
    s.receive(0, [session('ours', 'online', 'web')], 'SESSIONS_REPLACE', 3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(op3s()).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    s.receive(0, [session('ours', 'online', 'web')], 'SESSIONS_REPLACE', 4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(op3s()).toBe(3);
  });

  it('re-sends the current presence after resuming', async () => {
    const t = setup();
    await t.connect([session('desk', 'online')]);
    t.gw.setActivity({ type: 2, name: 'Plex' });
    t.last().drop(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    const s = t.last();
    s.receive(10, { heartbeat_interval: 40_000 });
    s.receive(0, null, 'RESUMED', 2);
    expect(s.sent[1]).toMatchObject({ op: 3, d: { status: 'online', activities: [{ type: 2, name: 'Plex' }] } });
  });

  it('heartbeats with the last sequence number, and reconnects (resuming) when acks stop', async () => {
    const t = setup();
    await t.connect([]);
    const first = t.last();
    await vi.advanceTimersByTimeAsync(20_000); // jittered first beat: interval * 0.5
    expect(first.sent.at(-1)).toEqual({ op: 1, d: 1 });
    await vi.advanceTimersByTimeAsync(40_000); // no ack arrived → zombie
    expect(first.closed).toEqual([4000]);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = t.last();
    expect(second).not.toBe(first);
    expect(second.url).toBe('wss://resume.test/?v=10&encoding=json');
    second.receive(10, { heartbeat_interval: 40_000 });
    expect(second.sent[0]).toEqual({ op: 6, d: { token: 'Bearer token-0', session_id: 'ours', seq: 1 } });
    second.receive(0, null, 'RESUMED', 2);
    expect(second.sent[1]).toMatchObject({ op: 3, d: { status: 'invisible' } });
    expect(t.gw.state).toBe('ready');
  });

  it('keeps trusting the last session list during a short reconnect', async () => {
    const t = setup();
    await t.connect([session('desk', 'online')]);
    t.last().drop(1006);
    expect(t.gw.state).toBe('reconnecting');
    expect(t.gw.informed).toBe(true);
    // Keep failing for longer than the grace period.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      t.last().drop(1006);
    }
    expect(t.gw.informed).toBe(false);
  });

  it('refreshes the token and identifies afresh after an authentication failure', async () => {
    const t = setup();
    await t.connect([]);
    t.last().drop(4004);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.refreshes()).toBe(1);
    const s = t.last();
    expect(s.url).toBe('wss://gateway.test/?v=10&encoding=json');
    s.receive(10, { heartbeat_interval: 40_000 });
    expect(s.sent[0]).toMatchObject({ op: 2, d: { token: 'Bearer token-1' } });
  });

  it('identifies afresh after a non-resumable invalid session', async () => {
    const t = setup();
    await t.connect([]);
    t.last().receive(9, false);
    await vi.advanceTimersByTimeAsync(1_000);
    t.last().receive(10, { heartbeat_interval: 40_000 });
    expect(t.last().ops()[0]).toBe(2);
  });

  it('gives up on fatal close codes', async () => {
    const t = setup();
    await t.connect([]);
    t.last().drop(4014);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.gw.state).toBe('failed');
    expect(t.sockets).toHaveLength(1);
    expect(t.gw.lastError).toMatch(/disallowed intents/);
  });

  it('closes with 1000 on stop and does not reconnect', async () => {
    const t = setup();
    await t.connect([session('desk', 'online')]);
    t.gw.stop();
    expect(t.sockets[0]!.closed).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.gw.state).toBe('stopped');
    expect(t.gw.informed).toBe(false);
  });
});

describe('onlineCheck', () => {
  const all = ['online', 'idle', 'dnd'] as const;

  it("ignores our own session, headless sessions and the aggregate", () => {
    const sessions = [session('ours', 'online'), session('h:abc', 'online'), session('all', 'online')];
    expect(onlineCheck(sessions, 'ours', [...all])).toEqual({ allowed: false, reason: "you're not signed in to Discord anywhere" });
  });

  it('allows when a real client has an allowed status', () => {
    expect(onlineCheck([session('ours', 'invisible'), session('desk', 'idle')], 'ours', [...all]).allowed).toBe(true);
    expect(onlineCheck([session('desk', 'idle')], 'ours', ['online']).allowed).toBe(false);
  });

  it('also ignores our earlier connections', () => {
    const sessions = [session('ours', 'invisible'), session('old-ours', 'online')];
    expect(onlineCheck(sessions, new Set(['ours', 'old-ours']), [...all]).allowed).toBe(false);
    expect(onlineCheck(sessions, 'ours', [...all]).allowed).toBe(true);
  });

  it('explains an invisible status', () => {
    expect(onlineCheck([session('desk', 'invisible'), session('phone', 'invisible', 'mobile')], 'ours', [...all])).toEqual({
      allowed: false,
      reason: 'your Discord status is invisible',
    });
  });
});
