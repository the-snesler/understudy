import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubState } from '../src/core/hub.js';
import type { DiscordActivity } from '../src/plugins/discord/headless.js';
import { Publisher, type PresenceGate, type SessionLike } from '../src/plugins/discord/publisher.js';
import { movie, quietLogger } from './helpers.js';

class FakeSession implements SessionLike {
  active = false;
  calls: Array<{ op: 'upsert'; activity: DiscordActivity } | { op: 'clear' }> = [];
  fail = false;
  clearFail = false;
  async upsert(activity: DiscordActivity) {
    if (this.fail) throw new Error('boom');
    this.calls.push({ op: 'upsert', activity });
    this.active = true;
  }
  async clear() {
    if (this.clearFail) throw new Error('clear failed');
    this.calls.push({ op: 'clear' });
    this.active = false;
  }
}

const state = (activity = movie()): HubState => {
  const selected = { sourceId: 'manual', activity, changedAt: 0 };
  return { activities: [selected], selected, selectionReason: 'Highest priority, then most recent' };
};
const emptyState = (): HubState => ({ activities: [], selected: null, selectionReason: 'No active source' });

function setup(opts: { ready?: boolean; gate?: PresenceGate; session?: FakeSession; reportShown?: (activity: HubState['selected']) => void } = {}) {
  const session = opts.session ?? new FakeSession();
  let ready = opts.ready ?? true;
  const publisher = new Publisher({
    config: { applicationId: '1', refreshMinutes: 5 },
    session,
    log: quietLogger(),
    ready: () => ready,
    gate: opts.gate,
    reportShown: opts.reportShown,
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
    publisher.onState(emptyState());
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
    publisher.onState(emptyState());
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

  it('uses the hub selection even when another activity appears first', async () => {
    const { publisher, session } = setup();
    const selectedState = state(movie({ title: 'Selected' }));
    selectedState.activities.unshift({ sourceId: 'other', activity: movie({ title: 'Other' }), changedAt: 100 });
    publisher.start();
    publisher.onState(selectedState);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(session.calls[0]).toMatchObject({ op: 'upsert', activity: { details: 'Selected' } });
  });

  it('reports only confirmed display states, including clearing', async () => {
    const reportShown = vi.fn();
    const session = new FakeSession();
    session.fail = true;
    const { publisher } = setup({ session, reportShown });
    publisher.start();
    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(1_500);
    expect(reportShown).not.toHaveBeenCalled();
    session.fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reportShown).toHaveBeenLastCalledWith(state().selected);
    publisher.onState(emptyState());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reportShown).toHaveBeenLastCalledWith(null);
  });

  it('waits for an in-flight send before withdrawing on stop', async () => {
    let finish: (() => void) | undefined;
    const session = new FakeSession();
    const original = session.upsert.bind(session);
    session.upsert = async (activity) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      await original(activity);
    };
    const { publisher } = setup({ session });
    publisher.start();
    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(1_500);
    const stopped = publisher.stop();
    finish!();
    await stopped;
    expect(session.calls.map((call) => call.op)).toEqual(['upsert', 'clear']);
    expect(session.active).toBe(false);
  });

  it('keeps the confirmed display state when clearing fails', async () => {
    const reportShown = vi.fn();
    const { publisher, session } = setup({ reportShown });
    publisher.start();
    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(1_500);
    reportShown.mockClear();
    session.clearFail = true;
    publisher.onState(emptyState());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(publisher.lastError).toBe('clear failed');
    expect(publisher.current()?.sourceId).toBe('manual');
    expect(reportShown).not.toHaveBeenCalled();
    session.clearFail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reportShown).toHaveBeenLastCalledWith(null);
  });

  it('invalidates the shown cache after a successful external clear', async () => {
    const reportShown = vi.fn();
    const { publisher, session, setReady } = setup({ reportShown });
    publisher.start();
    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(1_500);
    await session.clear();
    publisher.confirmCleared();
    setReady(false);
    publisher.kick();
    expect(publisher.current()).toBeNull();
    expect(reportShown).toHaveBeenLastCalledWith(null);
  });

  it('serializes Disconnect after an in-flight send and stays withdrawn until login resumes it', async () => {
    let finish: (() => void) | undefined;
    const session = new FakeSession();
    const original = session.upsert.bind(session);
    session.upsert = async (activity) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      await original(activity);
    };
    const reportShown = vi.fn();
    const { publisher } = setup({ session, reportShown });
    publisher.start();
    publisher.onState(state());
    await vi.advanceTimersByTimeAsync(1_500);
    const disconnected = publisher.disconnect(() => session.clear());
    publisher.onState(state(movie({ title: 'Latest activity' })));
    finish!();
    await disconnected;
    expect(session.calls.map((call) => call.op)).toEqual(['upsert', 'clear']);
    expect(publisher.current()).toBeNull();
    expect(reportShown).toHaveBeenLastCalledWith(null);
    publisher.kick(true); // Gateway callbacks and Re-send cannot undo Disconnect.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(session.calls).toHaveLength(2);
    session.upsert = original;
    publisher.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.calls[2]).toMatchObject({ op: 'upsert', activity: { details: 'Latest activity' } });
  });
});
