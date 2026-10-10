import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Controls } from '../src/core/controls.js';
import { Hub } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { defineSource } from '../src/core/plugin.js';
import { emptyConfig, Registry, type AppConfig } from '../src/core/registry.js';
import { inWindows, isValidTimeZone, minutesInZone, parseWindows } from '../src/core/schedule.js';
import { JsonStore, ScopedState } from '../src/core/store.js';
import { Publisher, type SessionLike } from '../src/plugins/discord/publisher.js';
import { createWebApp } from '../src/web/app.js';
import { movie, quietLogger, signIn } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-'));
  dirs.push(d);
  return d;
};

describe('schedule', () => {
  it('parses windows, including ones past midnight', () => {
    const w = parseWindows('23:00-07:00, 12:30–13:00');
    expect(w).toEqual([
      { start: 1380, end: 420 },
      { start: 750, end: 780 },
    ]);
    expect(inWindows(w, 23 * 60 + 30)).toBe(true);
    expect(inWindows(w, 6 * 60 + 59)).toBe(true);
    expect(inWindows(w, 7 * 60)).toBe(false);
    expect(inWindows(w, 12 * 60 + 45)).toBe(true);
    expect(inWindows(w, 13 * 60)).toBe(false);
    expect(parseWindows('')).toEqual([]);
    expect(() => parseWindows('late')).toThrow(/not a time range/);
    expect(() => parseWindows('25:00-07:00')).toThrow();
  });

  it('reads the time in a zone', () => {
    const noonUtc = new Date('2026-10-08T12:00:00Z');
    expect(minutesInZone(noonUtc, 'UTC')).toBe(720);
    expect(minutesInZone(noonUtc, 'America/Chicago')).toBe(7 * 60); // CDT, UTC-5
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

function controls(dir = tmp()) {
  const hub = new Hub();
  const store = new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({}));
  const c = new Controls(new ScopedState(store, '_app'), hub, quietLogger());
  return { c, hub, dir };
}

describe('Controls', () => {
  it('pauses for a while, then resumes by itself', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { c, hub } = controls();
    c.start();
    const states: boolean[] = [];
    hub.subscribe((s) => states.push(!!s.paused));
    expect(await c.pause(30)).toEqual({ paused: true, since: 1_000_000, until: 1_000_000 + 30 * 60_000 });
    expect(hub.snapshot().paused).toBe(true);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(c.pauseInfo()).toEqual({ paused: false });
    expect(states).toEqual([true, false]);
  });

  it('pauses until resumed, and survives a restart', async () => {
    const dir = tmp();
    const first = controls(dir);
    first.c.start();
    await first.c.pause();
    expect(first.c.pauseInfo()).toMatchObject({ paused: true, until: undefined });
    first.c.stop();

    const second = controls(dir);
    second.c.start();
    expect(second.hub.snapshot().paused).toBe(true);
    await second.c.resume();
    expect(second.hub.snapshot().paused).toBe(false);
  });

  it('drops a timed pause that ended while stopped', async () => {
    const dir = tmp();
    const first = controls(dir);
    await first.c.pause(1);
    vi.useFakeTimers({ now: Date.now() + 5 * 60_000 });
    const second = controls(dir);
    second.c.start();
    expect(second.hub.snapshot().paused).toBe(false);
  });
});

describe('Publisher and pause', () => {
  it('withdraws the activity while paused and brings it back after', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const calls: string[] = [];
    let active = false;
    const session: SessionLike = {
      get active() {
        return active;
      },
      upsert: async () => void (calls.push('upsert'), (active = true)),
      clear: async () => void (calls.push('clear'), (active = false)),
    };
    const p = new Publisher({
      config: { applicationId: '1', sourcePriority: [], paused: 'last', refreshMinutes: 5 },
      session,
      log: quietLogger(),
      sources: () => [{ id: 'm', label: 'm', enabled: true }],
      ready: () => true,
    });
    p.start();
    const activities = [{ sourceId: 'm', activity: movie(), changedAt: 0 }];
    p.onState({ activities });
    await vi.advanceTimersByTimeAsync(1_500);
    p.onState({ activities, paused: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(p.gateReason).toBe('publishing is paused');
    p.onState({ activities, paused: false });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toEqual(['upsert', 'clear', 'upsert']);
  });
});

describe('web pause controls and API', () => {
  const source = defineSource({
    id: 'src',
    name: 'Source',
    description: '',
    configSchema: z.object({}),
    create: () => ({ start() {}, stop() {}, status: () => ({ health: 'idle', message: 'ok' }) }),
  });

  async function boot() {
    const dir = tmp();
    const hub = new Hub();
    const logs = new LogBuffer();
    const state = new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({}));
    const registry = new Registry({
      plugins: [source],
      config: new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig),
      state,
      hub,
      log: new Logger(logs, 'test', 'error'),
      env: { publicUrl: undefined },
    });
    await registry.ensureInstances([{ plugin: 'src', enabled: true }]);
    await registry.startAll();
    const c = new Controls(new ScopedState(state, '_app'), hub, quietLogger());
    c.start();
    const app = createWebApp({ registry, hub, logs, env: { publicUrl: undefined }, uiPassword: 'pw', controls: c });
    const auth = { Authorization: `Basic ${Buffer.from('ha:pw').toString('base64')}` };
    const session = await signIn(app, 'pw');
    return { app, hub, registry, auth, session, c };
  }

  it('pauses and resumes from the dashboard', async () => {
    const t = await boot();
    const form = (p: string, body: Record<string, string>) =>
      t.app.request(p, { method: 'POST', body: new URLSearchParams(body), headers: { ...t.session, Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(await (await t.app.request('/', { headers: t.session })).text()).toContain('Pause publishing');
    await form('/pause', { minutes: '60' });
    expect(t.c.pauseInfo()).toMatchObject({ paused: true });
    expect(await (await t.app.request('/partials/dashboard', { headers: t.session })).text()).toContain('Publishing is paused');
    await form('/resume', {});
    expect(t.c.pauseInfo().paused).toBe(false);

    // Dashboard toggles come back to the dashboard; foreign redirects are ignored.
    const off = await form('/instances/src/disable', { return: '/' });
    expect(off.headers.get('location')).toBe('/');
    expect(t.registry.get('src')?.config.enabled).toBe(false);
    const on = await form('/instances/src/enable', { return: '//evil.example' });
    expect(on.headers.get('location')).toBe('/instances/src');
    t.c.stop();
  });

  it('offers a JSON API behind the same password', async () => {
    const t = await boot();
    expect((await t.app.request('/api/status')).status).toBe(401);
    expect((await t.app.request('/api/status', { headers: { Authorization: `Basic ${Buffer.from('ha:nope').toString('base64')}` } })).status).toBe(401);
    // A signed-in browser can use it too.
    expect((await t.app.request('/api/status', { headers: t.session })).status).toBe(200);
    const status = (await (await t.app.request('/api/status', { headers: t.auth })).json()) as { pause: { paused: boolean }; instances: { id: string }[] };
    expect(status.pause.paused).toBe(false);
    expect(status.instances.map((i) => i.id)).toEqual(['src']);

    // curl / Home Assistant style: JSON, no Origin header.
    const paused = await t.app.request('/api/pause', { method: 'POST', body: JSON.stringify({ minutes: 15 }), headers: { ...t.auth, 'Content-Type': 'application/json' } });
    expect(((await paused.json()) as { pause: { paused: boolean; until: number } }).pause.paused).toBe(true);
    expect(t.hub.snapshot().paused).toBe(true);
    const json = { ...t.auth, 'Content-Type': 'application/json' };
    expect((await t.app.request('/api/toggle', { method: 'POST', headers: t.auth })).status).toBe(415); // not JSON
    expect(t.c.pauseInfo().paused).toBe(true);
    await t.app.request('/api/toggle', { method: 'POST', headers: json });
    expect(t.c.pauseInfo().paused).toBe(false);
    await t.app.request('/api/toggle', { method: 'POST', headers: json });
    expect(t.c.pauseInfo()).toMatchObject({ paused: true, until: undefined });
    await t.app.request('/api/resume', { method: 'POST', headers: json });
    expect(t.c.pauseInfo().paused).toBe(false);
    t.c.stop();
  });
});
