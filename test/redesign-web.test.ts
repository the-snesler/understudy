import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HistoryStore } from '../src/core/history.js';
import { Hub, type HubState } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { defineOutput, defineSource, type InstanceStatus } from '../src/core/plugin.js';
import { Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore, ScopedState } from '../src/core/store.js';
import { createWebApp } from '../src/web/app.js';
import { movie, signIn } from './helpers.js';

const resources: { registry: Registry; history: HistoryStore; dir: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.registry.stopAll();
    resource.history.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

async function boot() {
  vi.useFakeTimers({ now: Date.parse('2026-10-10T12:00:00Z') });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-redesign-web-'));
  const hub = new Hub();
  const history = new HistoryStore(':memory:', { heartbeatIntervalMs: 0 });
  hub.attachHistory(history);
  const logs = new LogBuffer();
  const starts: Record<string, number> = {};
  const stops: Record<string, number> = {};
  const health = new Map<string, InstanceStatus>();
  const received = new Map<string, HubState[]>();
  const source = defineSource({
    id: 'source', name: 'Test source', description: '', multiple: true,
    configSchema: z.object({ title: z.string().default('An activity') }),
    create: (ctx) => ({
      start() {
        starts[ctx.instanceId] = (starts[ctx.instanceId] ?? 0) + 1;
        ctx.publish(movie({ key: ctx.instanceId, title: ctx.config.title }));
        ctx.reportSuccess?.();
      },
      stop() { stops[ctx.instanceId] = (stops[ctx.instanceId] ?? 0) + 1; },
      status: () => health.get(ctx.instanceId) ?? { health: 'ok', message: 'Reachable' },
    }),
  });
  const output = defineOutput({
    id: 'output', name: 'Test output', description: '', multiple: true,
    configSchema: z.object({ endpoint: z.string().min(1).default('ready') }),
    create: (ctx) => ({
      start() { starts[ctx.instanceId] = (starts[ctx.instanceId] ?? 0) + 1; },
      stop() { stops[ctx.instanceId] = (stops[ctx.instanceId] ?? 0) + 1; },
      status: () => ({ health: 'ok', message: 'Connected' }),
      onState(state) {
        const states = received.get(ctx.instanceId) ?? [];
        states.push(state);
        received.set(ctx.instanceId, states);
        ctx.reportShown(state.selected);
        ctx.reportSuccess?.();
      },
    }),
  });
  const initial: AppConfig = {
    version: 1,
    hub: { paused: 'hide', quietHours: '', timeZone: 'UTC' },
    instances: [
      { id: 'first-output', plugin: 'output', enabled: true, label: 'First output', config: { endpoint: 'ready' } },
      { id: 'a', plugin: 'source', enabled: true, label: 'Source A', config: { title: 'Activity A' } },
      { id: 'second-output', plugin: 'output', enabled: true, label: 'Second output', config: { endpoint: 'ready' } },
      { id: 'b', plugin: 'source', enabled: true, label: 'Source B', config: { title: 'Activity B' } },
      { id: 'c', plugin: 'source', enabled: true, label: 'Source C', config: { title: 'Activity C' } },
    ],
  };
  const config = new JsonStore<AppConfig>(path.join(dir, 'config.json'), () => initial);
  const stateFile = path.join(dir, 'state.json');
  const state = new JsonStore<Record<string, unknown>>(stateFile, () => ({}));
  const registry = new Registry({
    plugins: [source, output], config, state, hub, log: new Logger(logs, 'test', 'error'),
    env: { publicUrl: undefined, dataDir: dir },
  });
  resources.push({ registry, history, dir });
  await registry.startAll();
  const preferences = new ScopedState<{ attentionDismissedAt?: number }>(state, '_preferences');
  const options = {
    registry, hub, logs, history, preferences, env: { publicUrl: undefined },
    uiPassword: 'pw', sessionSecret: 'a-fixed-web-test-session-secret',
  };
  const app = createWebApp(options);
  const session = await signIn(app, 'pw');
  const form = (url: string, values: Record<string, string>, extraHeaders: Record<string, string> = {}) => app.request(url, {
    method: 'POST', body: new URLSearchParams(values),
    headers: { ...session, Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
  });
  const reorder = (input: unknown, headers: Record<string, string> = session) => app.request('/instances/reorder', {
    method: 'POST', body: JSON.stringify(input), headers: { ...headers, 'Content-Type': 'application/json' },
  });
  const latest = (id: string) => received.get(id)?.at(-1);
  return { app, options, session, form, reorder, latest, hub, registry, config, history, logs, health, starts, stops, preferences, stateFile };
}

describe('source priority routes', () => {
  it('requires authentication and rejects forged form requests before changing priority', async () => {
    const t = await boot();
    const unauthorized = await t.reorder({ ids: ['c', 'b', 'a'] }, {});
    expect(unauthorized.status).toBe(303);
    expect(unauthorized.headers.get('location')).toBe('/login');
    expect((await t.form('/instances/reorder', { id: 'c', index: '0' }, { Origin: 'https://other.example' })).status).toBe(403);
    expect(t.registry.sources().map((source) => source.id)).toEqual(['a', 'b', 'c']);
    expect(t.hub.snapshot().selected?.sourceId).toBe('a');
  });

  it('rejects duplicate, missing, unknown and output IDs without partially changing order', async () => {
    const t = await boot();
    const original = t.config.get().instances.map((instance) => instance.id);
    for (const input of [
      { ids: ['a', 'a', 'c'] }, { ids: ['a', 'b'] }, { ids: ['a', 'b', 'unknown'] },
      { ids: ['a', 'b', 'first-output'] }, { id: 'unknown', index: 0 },
      { id: 'first-output', index: 0 }, { id: 'a', index: 100 }, { id: 'a', index: -1 },
    ]) {
      expect((await t.reorder(input)).status).toBe(400);
      expect(t.config.get().instances.map((instance) => instance.id)).toEqual(original);
    }
    expect(t.hub.snapshot().selected?.sourceId).toBe('a');
  });

  it('updates selected activity immediately, preserves output positions, and avoids restarts', async () => {
    const t = await boot();
    const starts = { ...t.starts };
    const response = await t.reorder({ ids: ['c', 'a', 'b'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ids: ['c', 'a', 'b'] });
    expect(t.config.get().instances.map((instance) => instance.id)).toEqual(['first-output', 'c', 'second-output', 'a', 'b']);
    expect(t.hub.snapshot().selected?.sourceId).toBe('c');
    expect(t.latest('first-output')?.selected?.sourceId).toBe('c');
    expect(t.latest('second-output')?.selected?.sourceId).toBe('c');
    expect(t.starts).toEqual(starts);
    expect(t.stops).toEqual({});
    expect((await t.form('/instances/reorder', { id: 'a', index: '0' })).status).toBe(200);
    expect(t.registry.sources().map((source) => source.id)).toEqual(['a', 'c', 'b']);
    expect(t.hub.snapshot().selected?.sourceId).toBe('a');
  });
});

describe('history link access', () => {
  it('allows public feed reads only with a valid token and protects unrelated routes', async () => {
    const t = await boot();
    await vi.advanceTimersByTimeAsync(1000);
    const token = t.history.token();
    expect((await t.app.request('/settings')).status).toBe(303);
    expect((await t.app.request(`/api/status?token=${token}`)).status).toBe(401);
    for (const route of ['/feed/history.ics', '/api/history.json']) {
      expect((await t.app.request(route)).status).toBe(401);
      expect((await t.app.request(`${route}?token=invalid`, { headers: t.session })).status).toBe(401);
      const response = await t.app.request(`${route}?token=${token}`);
      expect(response.status).toBe(200);
      if (route.endsWith('.ics')) expect(await response.text()).toContain('BEGIN:VEVENT');
      else expect(await response.json()).toMatchObject({ timeZone: 'UTC', segments: expect.arrayContaining([
        expect.objectContaining({ sourceId: 'a' }), expect.objectContaining({ sourceId: 'b' }), expect.objectContaining({ sourceId: 'c' }),
      ]) });
    }
  });

  it('requires an authenticated, same-origin Settings rotation and revokes old links', async () => {
    const t = await boot();
    const token = t.history.token();
    const anonymous = await t.app.request('/settings/feeds/regenerate', {
      method: 'POST', body: new URLSearchParams(),
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(anonymous.status).toBe(303);
    expect(t.history.token()).toBe(token);
    expect((await t.form('/settings/feeds/regenerate', {}, { Origin: 'https://other.example' })).status).toBe(403);
    expect(t.history.token()).toBe(token);
    const rotated = await t.form('/settings/feeds/regenerate', {});
    expect(rotated.status).toBe(302);
    expect(rotated.headers.get('location')).toBe('/settings?notice=regenerated');
    const replacement = t.history.token();
    expect(replacement).not.toBe(token);
    for (const route of ['/feed/history.ics', '/api/history.json']) {
      expect((await t.app.request(`${route}?token=${token}`)).status).toBe(401);
      expect((await t.app.request(`${route}?token=${replacement}`)).status).toBe(200);
    }
    const settings = await (await t.app.request('/settings', { headers: t.session })).text();
    expect(settings).toContain(replacement);
    expect(settings).not.toContain(token);
  });
});

describe('Hub and output selection settings', () => {
  it('applies valid global rules immediately and keeps invalid rules from changing selection or restarting plugins', async () => {
    const t = await boot();
    t.hub.set('a', movie({ key: 'a', title: 'Activity A', paused: true }));
    expect(t.hub.snapshot().selected?.sourceId).toBe('b');
    const starts = { ...t.starts };
    const valid = await t.form('/settings/hub', { 'cfg.paused': 'show', 'cfg.quietHours': '', 'cfg.timeZone': 'UTC' });
    expect(valid.status).toBe(302);
    expect(t.hub.snapshot().selected?.sourceId).toBe('a');
    expect(t.latest('first-output')?.selected?.sourceId).toBe('a');
    for (const invalid of [
      { 'cfg.paused': 'show', 'cfg.quietHours': '25:00-06:00', 'cfg.timeZone': 'UTC' },
      { 'cfg.paused': 'show', 'cfg.quietHours': '', 'cfg.timeZone': 'Mars/Olympus' },
    ]) {
      const response = await t.form('/settings/hub', invalid);
      expect(await response.text()).toContain('Some rules are invalid');
      expect(t.registry.hubRules()).toEqual({ paused: 'show', quietHours: '', timeZone: 'UTC' });
      expect(t.hub.snapshot().selected?.sourceId).toBe('a');
    }
    expect(t.starts).toEqual(starts);
    expect(t.stops).toEqual({});
  });

  it('changes only one output’s rules without reconnecting it and validates before saving', async () => {
    const t = await boot();
    t.hub.set('a', movie({ key: 'a', title: 'Activity A', paused: true }));
    const starts = { ...t.starts };
    const values = {
      'cfg.endpoint': 'ready', label: 'First output', rulesEnabled: 'on',
      'rules.paused': 'show', 'rules.quietHours': '', 'rules.timeZone': 'UTC',
    };
    const invalidRules = await t.form('/instances/first-output/settings', { ...values, 'rules.timeZone': 'Mars/Olympus' });
    expect(await invalidRules.text()).toContain('Some settings are invalid');
    expect(t.registry.get('first-output')?.config.rules).toBeUndefined();
    expect(t.starts).toEqual(starts);
    const invalidConfig = await t.form('/instances/first-output/settings', { ...values, 'cfg.endpoint': '' });
    expect(await invalidConfig.text()).toContain('Some settings are invalid');
    expect(t.registry.get('first-output')?.config.config).toEqual({ endpoint: 'ready' });
    expect(t.registry.get('first-output')?.config.rules).toBeUndefined();
    expect(t.starts).toEqual(starts);
    expect((await t.form('/instances/first-output/settings', values)).status).toBe(302);
    expect(t.registry.get('first-output')?.config.rules).toEqual({ paused: 'show', quietHours: '', timeZone: 'UTC' });
    expect(t.latest('first-output')?.selected?.sourceId).toBe('a');
    expect(t.latest('second-output')?.selected?.sourceId).toBe('b');
    expect(t.hub.snapshot().selected?.sourceId).toBe('b');
    expect(t.starts).toEqual(starts);
    expect(t.stops).toEqual({});
    await t.form('/settings/hub', { 'cfg.paused': 'hide', 'cfg.quietHours': '00:00-23:59', 'cfg.timeZone': 'UTC' });
    expect(t.hub.snapshot().selected).toBeNull();
    expect(t.latest('second-output')?.selected).toBeNull();
    expect(t.latest('first-output')?.selected?.sourceId).toBe('a');
    expect(t.starts).toEqual(starts);
  });
});

describe('Needs attention dismissal', () => {
  it('persists dismissal while retaining active health problems and warnings arriving afterward', async () => {
    const t = await boot();
    t.health.set('a', { health: 'warning', message: 'An active connection warning' });
    t.logs.push({ at: Date.now() - 2000, scope: 'a', level: 'warn', message: 'A previous warning' });
    const through = Date.now() - 1000;
    t.logs.push({ at: through, scope: 'first-output', level: 'error', message: 'A previous output failure' });
    const before = await (await t.app.request('/partials/dashboard', { headers: t.session })).text();
    expect(before).toContain('An active connection warning');
    expect(before).toContain('A previous warning');
    expect(before).toContain('A previous output failure');
    expect((await t.form('/attention/dismiss', { through: String(through) }, { Origin: 'https://other.example' })).status).toBe(403);
    expect(t.preferences.get()).toBeUndefined();
    expect((await t.form('/attention/dismiss', { through: 'bad' })).status).toBe(400);
    expect((await t.form('/attention/dismiss', { through: String(through) })).status).toBe(302);
    expect(t.preferences.get()).toEqual({ attentionDismissedAt: through });
    const persisted = new JsonStore<Record<string, unknown>>(t.stateFile, () => ({}));
    const nextPreferences = new ScopedState<{ attentionDismissedAt?: number }>(persisted, '_preferences');
    expect(nextPreferences.get()).toEqual({ attentionDismissedAt: through });
    const nextApp = createWebApp({ ...t.options, preferences: nextPreferences });
    const after = await (await nextApp.request('/partials/dashboard', { headers: t.session })).text();
    expect(after).toContain('An active connection warning');
    expect(after).not.toContain('A previous warning');
    expect(after).not.toContain('A previous output failure');
    await vi.advanceTimersByTimeAsync(1000);
    t.logs.push({ at: Date.now(), scope: 'b', level: 'warn', message: 'A newly arrived warning' });
    expect(await (await nextApp.request('/partials/dashboard', { headers: t.session })).text()).toContain('A newly arrived warning');
  });
});
