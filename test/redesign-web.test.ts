import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HistoryStore } from '../src/core/history.js';
import { Hub, type HubState } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { defineHistorySource, defineOutput, defineSource, type InstanceStatus } from '../src/core/plugin.js';
import { Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore, ScopedState } from '../src/core/store.js';
import { calendarFeedPlugin } from '../src/plugins/feeds/calendar.js';
import { jsonFeedPlugin } from '../src/plugins/feeds/json.js';
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
  // Stands in for the iCal source: copies one calendar event in on start.
  const imported = defineHistorySource({
    id: 'imported', name: 'Imported calendar', description: '', service: 'calendar', multiple: true,
    configSchema: z.object({}),
    create: (ctx) => ({
      start() {
        const now = Date.now();
        ctx.history.importEntries({ from: now - 86_400_000, to: now }, [{ uid: 'lecture', title: 'Imported lecture', startedAt: now - 3_600_000, endedAt: now - 1_800_000 }]);
      },
      stop() {},
      status: () => ({ health: 'ok', message: 'Imported' }),
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
    plugins: [source, output, imported, calendarFeedPlugin, jsonFeedPlugin], config, state, hub, log: new Logger(logs, 'test', 'error'),
    env: { publicUrl: undefined, dataDir: dir },
  });
  resources.push({ registry, history, dir });
  registry.attachHistory(history);
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

async function addFeed(t: Awaited<ReturnType<typeof boot>>, plugin: string): Promise<{ id: string; url: URL }> {
  const added = await t.form('/instances', { plugin });
  const id = added.headers.get('location')!.match(/\/instances\/([^?]+)/)![1]!;
  await t.form(`/instances/${id}/enable`, {});
  const page = await (await t.app.request(`/instances/${id}`, { headers: t.session })).text();
  const link = page.match(/data-copy="(http:\/\/localhost\/public\/[^"]+)"/)![1]!.replace(/&amp;/g, '&');
  return { id, url: new URL(link) };
}

describe('history feed outputs', () => {
  it('publish only once added and enabled, with their own token, and leave the old routes to the output', async () => {
    const t = await boot();
    await t.form('/instances', { plugin: 'imported' });
    await t.form('/instances/imported/enable', {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.history.query({ sourceId: 'imported' })).toHaveLength(1);
    expect((await t.app.request('/feed/history.ics?token=anything')).status).toBe(404);
    expect((await t.app.request('/api/history.json?token=anything')).status).toBe(404);
    const overview = await (await t.app.request('/', { headers: t.session })).text();
    expect(overview).not.toContain('/feed/history.ics');

    const calendar = await addFeed(t, 'calendar-feed');
    const token = calendar.url.searchParams.get('token')!;
    expect(calendar.url.pathname).toBe(`/public/${calendar.id}/calendar.ics`);
    expect((await t.app.request(calendar.url.pathname)).status).toBe(401);
    expect((await t.app.request(`${calendar.url.pathname}?token=invalid`, { headers: t.session })).status).toBe(401);
    expect((await t.app.request(`/api/status?token=${token}`)).status).toBe(401);
    const ics = await t.app.request(calendar.url.pathname + calendar.url.search);
    expect(ics.status).toBe(200);
    expect(ics.headers.get('cache-control')).toBe('private, no-store');
    const text = await ics.text();
    expect(text).toContain('SUMMARY:Activity A');
    // The no-echo rule: events imported from a calendar never go back out in a calendar feed.
    expect(text).not.toContain('Imported lecture');
    expect((await t.app.request(`/feed/history.ics?token=${token}`)).status).toBe(200);
    expect((await t.app.request('/feed/history.ics?token=invalid')).status).toBe(401);

    const json = await addFeed(t, 'json-feed');
    const body = await (await t.app.request(json.url.pathname + json.url.search)).json() as { segments: unknown[] };
    expect(body).toMatchObject({ timeZone: 'UTC', outputSegments: expect.any(Array) });
    expect(body.segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'a', sourceLabel: 'Source A' }),
      expect.objectContaining({ title: 'Imported lecture', kind: 'event', origin: 'calendar' }),
    ]));
    expect((await t.app.request(`/api/history.json?token=${json.url.searchParams.get('token')}&from=bad`)).status).toBe(400);

    await t.form(`/instances/${calendar.id}/disable`, {});
    expect((await t.app.request(calendar.url.pathname + calendar.url.search)).status).toBe(404);
  });

  it('rotates one feed link with an authenticated, same-origin request', async () => {
    const t = await boot();
    const feed = await addFeed(t, 'calendar-feed');
    const path = `/plugins/${feed.id}/regenerate`;
    const anonymous = await t.app.request(path, {
      method: 'POST', body: new URLSearchParams(),
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(anonymous.status).toBe(303);
    expect((await t.form(path, {}, { Origin: 'https://other.example' })).status).toBe(403);
    expect((await t.app.request(feed.url.pathname + feed.url.search)).status).toBe(200);
    expect((await t.form(path, {})).status).toBe(302);
    expect((await t.app.request(feed.url.pathname + feed.url.search)).status).toBe(401);
    const page = await (await t.app.request(`/instances/${feed.id}`, { headers: t.session })).text();
    expect(page).not.toContain(feed.url.searchParams.get('token')!);
    expect(page).toContain('Never includes history copied in by Imported calendar');
  });
});

describe('history sources and the Calendar', () => {
  it('keeps history sources out of the Hub, shows them in the Calendar, and deletes their entries on removal', async () => {
    const t = await boot();
    const added = await t.form('/instances', { plugin: 'imported' });
    expect(added.headers.get('location')).toBe('/instances/imported?notice=added');
    await t.form('/instances/imported/enable', {});
    expect(t.registry.sources().map((source) => source.id)).toEqual(['a', 'b', 'c']);
    expect(t.hub.get('imported')).toBeUndefined();
    const overview = await (await t.app.request('/', { headers: t.session })).text();
    expect(overview).toContain('History sources');
    expect(overview).toContain('/instances/imported');
    const page = await (await t.app.request('/instances/imported', { headers: t.session })).text();
    expect(page).toContain('History only.');
    expect((await (await t.app.request('/instances/new?kind=history', { headers: t.session })).text())).toContain('Add history source');

    await vi.advanceTimersByTimeAsync(60_000);
    const calendar = await (await t.app.request('/calendar', { headers: t.session })).text();
    expect(calendar).toContain('Oct 5 – 11, 2026');
    expect(calendar).toContain('Imported lecture');
    expect(calendar).toContain('Activity A');
    expect(calendar).toContain('Calendar event · <a href="/instances/imported">Imported calendar</a>');
    const partial = await (await t.app.request('/partials/calendar?date=2026-10-20', { headers: t.session })).text();
    expect(partial).toContain('Oct 19 – 25, 2026');
    expect(partial).toContain('This day hasn’t happened yet.');
    const timeline = await t.app.request('/timeline', { headers: t.session });
    expect([timeline.status, timeline.headers.get('location')]).toEqual([301, '/calendar']);

    expect(t.history.query({ sourceId: 'imported' })).toHaveLength(1);
    await t.form('/instances/imported/remove', {});
    expect(t.history.query({ sourceId: 'imported' })).toHaveLength(0);
    expect(t.history.query({ sourceId: 'a' }).length).toBeGreaterThan(0);
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
