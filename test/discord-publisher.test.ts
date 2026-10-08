import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubState } from '../src/core/hub.js';
import type { DiscordActivity } from '../src/plugins/discord/headless.js';
import { Publisher, type PresenceGate, type SessionLike } from '../src/plugins/discord/publisher.js';
import { movie, quietLogger } from './helpers.js';

class FakeSession implements SessionLike {
  active = false;
  calls: Array<{ op: 'upsert'; activity: DiscordActivity } | { op: 'clear' }> = [];
  fail = false;
  async upsert(activity: DiscordActivity) {
    if (this.fail) throw new Error('boom');
    this.calls.push({ op: 'upsert', activity });
    this.active = true;
  }
  async clear() {
    this.calls.push({ op: 'clear' });
    this.active = false;
  }
}

const sources = () => [{ id: 'manual', label: 'Manual', enabled: true }];
const state = (activity = movie()): HubState => ({ activities: [{ sourceId: 'manual', activity, changedAt: 0 }] });

function setup(opts: { ready?: boolean; gate?: PresenceGate; session?: FakeSession } = {}) {
  const session = opts.session ?? new FakeSession();
  let ready = opts.ready ?? true;
  const publisher = new Publisher({
    config: { applicationId: '1', sourcePriority: [], pausedLast: true, statusDisplay: 'details', refreshMinutes: 5 },
    session,
    log: quietLogger(),
    sources,
    ready: () => ready,
    gate: opts.gate,
  });
  return { publisher, session, setReady: (r: boolean) => (ready = r) };
}

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe('Publisher', () => {
  it('debounces bursts into one send', async () => {
    const { publisher, session } = setup();
    publisher.start();
    publisher.onState(state(movie({ title: 'Title A' })));
    publisher.onState(state(movie({ title: 'Title B' })));
    publisher.onState(state(movie({ title: 'Title C' })));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]).toMatchObject({ op: 'upsert', activity: { details: 'Title C' } });
  });

  it('skips equivalent updates, then re-sends on the refresh interval', async () => {
    const { publisher, session } = setup();
    publisher.start();
    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(1_500);
    publisher.onState(state(movie({ startedAt: 1_002_000 }))); // within jitter tolerance
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(session.calls).toHaveLength(2);
    expect(session.calls[1]?.op).toBe('upsert');
  });

  it('clears when the source stops, and on stop()', async () => {
    const { publisher, session } = setup();
    publisher.start();
    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(1_500);
    publisher.onState({ activities: [] });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(session.calls.map((c) => c.op)).toEqual(['upsert', 'clear']);
    expect(publisher.current()).toBeNull();

    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(3_000);
    await publisher.stop();
    expect(session.calls.map((c) => c.op)).toEqual(['upsert', 'clear', 'upsert', 'clear']);
  });

  it('deletes a session left over from a previous run when there is nothing to show', async () => {
    const session = new FakeSession();
    session.active = true;
    const { publisher } = setup({ session });
    publisher.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(session.calls.map((c) => c.op)).toEqual(['clear']);
  });

  it('makes no calls when there is nothing to show and no session', async () => {
    const { publisher, session } = setup();
    publisher.start();
    publisher.onState({ activities: [] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.calls).toEqual([]);
  });

  it('waits until connected, then sends', async () => {
    const { publisher, session, setReady } = setup({ ready: false });
    publisher.start();
    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.calls).toEqual([]);
    setReady(true);
    publisher.kick(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(session.calls).toHaveLength(1);
  });

  it('retries after a failure', async () => {
    const session = new FakeSession();
    session.fail = true;
    const { publisher } = setup({ session });
    publisher.start();
    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(1_500);
    expect(publisher.lastError).toBe('boom');
    session.fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.calls).toHaveLength(1);
    expect(publisher.lastError).toBeUndefined();
  });

  it('respects the gate', async () => {
    let allowed = false;
    const { publisher, session } = setup({ gate: { check: () => ({ allowed, reason: 'you are offline' }) } });
    publisher.start();
    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.calls).toEqual([]);
    expect(publisher.gateReason).toBe('you are offline');
    allowed = true;
    publisher.kick();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.calls).toHaveLength(1);
  });
});
