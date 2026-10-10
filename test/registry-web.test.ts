import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Hub } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { defineOutput, defineSource } from '../src/core/plugin.js';
import { emptyConfig, Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore } from '../src/core/store.js';
import { createWebApp } from '../src/web/app.js';
import { parseSettingsForm } from '../src/web/forms.js';
import { movie } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const events: string[] = [];
const testSource = defineSource({
  id: 'test-source',
  name: 'Test source',
  description: 'publishes on start',
  multiple: true,
  configSchema: z.object({
    title: z.string().default('Hello').meta({ title: 'Title' }),
    apiKey: z.string().default('').meta({ title: 'API key', secret: true }),
    count: z.number().int().min(1).default(3),
    on: z.boolean().default(true),
    tags: z.array(z.string()).default([]),
  }),
  create: (ctx) => ({
    start: () => {
      events.push(`start ${ctx.instanceId} ${ctx.config.title}`);
      ctx.publish(movie({ title: ctx.config.title }));
    },
    stop: () => void events.push(`stop ${ctx.instanceId}`),
    status: () => ({ health: 'ok', message: 'fine' }),
  }),
});
const received: number[] = [];
const testOutput = defineOutput({
  id: 'test-output',
  name: 'Test output',
  description: 'records states',
  configSchema: z.object({}),
  create: () => ({
    start() {},
    stop() {},
    status: () => ({ health: 'idle', message: '' }),
    onState: (s) => void received.push(s.activities.length),
  }),
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srpc-test-'));
  dirs.push(dir);
  const hub = new Hub();
  const logs = new LogBuffer();
  const config = new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig);
  const state = new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({}));
  const registry = new Registry({
    plugins: [testSource, testOutput],
    config,
    state,
    hub,
    log: new Logger(logs, 'test', 'error'),
    env: { publicUrl: undefined },
  });
  return { dir, hub, logs, registry, config };
}

describe('Registry', () => {
  it('creates defaults, starts instances and wires sources to outputs via the hub', async () => {
    events.length = 0;
    received.length = 0;
    const { registry, hub } = setup();
    await registry.ensureInstances([
      { plugin: 'test-output', enabled: true },
      { plugin: 'test-source', enabled: true },
    ]);
    await registry.startAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(hub.get('test-source')?.activity.title).toBe('Hello');
    expect(received.at(-1)).toBe(1);

    const result = await registry.saveConfig('test-source', { title: 'Changed' });
    expect(result.ok).toBe(true);
    expect(events).toEqual(['start test-source Hello', 'stop test-source', 'start test-source Changed']);
    expect(hub.get('test-source')?.activity.title).toBe('Changed');

    await registry.setEnabled('test-source', false);
    expect(hub.get('test-source')).toBeUndefined();
    expect(received.at(-1)).toBe(0);
  });

  it('rejects invalid settings without restarting', async () => {
    const { registry } = setup();
    await registry.ensureInstances([{ plugin: 'test-source', enabled: true }]);
    await registry.startAll();
    const result = await registry.saveConfig('test-source', { count: 0 });
    expect(result.ok).toBe(false);
    expect(registry.get('test-source')?.config.config.count).toBe(3);
  });

  it('numbers additional instances', async () => {
    const { registry } = setup();
    await registry.ensureInstances([{ plugin: 'test-source', enabled: false }]);
    expect(await registry.add('test-source')).toBe('test-source-2');
    await expect(registry.add('test-output')).resolves.toBe('test-output');
    await expect(registry.add('test-output')).rejects.toThrow(/only be added once/);
  });

  it('only creates defaults on first run, so removed instances stay removed', async () => {
    const { registry, dir } = setup();
    const defaults = [
      { plugin: 'test-output', enabled: true },
      { plugin: 'test-source', enabled: true },
    ];
    await registry.ensureInstances(defaults);
    await registry.remove('test-source');

    const restarted = new Registry({
      plugins: [testSource, testOutput],
      config: new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig),
      state: new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({})),
      hub: new Hub(),
      log: new Logger(new LogBuffer(), 'test', 'error'),
      env: { publicUrl: undefined },
    });
    await restarted.ensureInstances(defaults);
    expect(restarted.list().map((v) => v.config.id)).toEqual(['test-output']);
  });

  it('persists config with private file permissions', async () => {
    const { registry, dir } = setup();
    await registry.ensureInstances([{ plugin: 'test-source', enabled: false }]);
    const mode = fs.statSync(path.join(dir, 'config.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('settings form parsing', () => {
  it('converts form fields by schema type and keeps blank secrets', () => {
    const raw = parseSettingsForm(
      testSource.configSchema,
      {
        'cfg.title': 'T',
        'cfg.apiKey': '',
        'cfg.count': '7',
        'cfg.on.__bool': '1',
        'cfg.tags': 'a\n\n b \r\nc',
      },
      { apiKey: 'kept' },
    );
    expect(raw).toEqual({ title: 'T', apiKey: 'kept', count: 7, on: false, tags: ['a', 'b', 'c'] });
  });

  it('parses checkbox groups for enum arrays', () => {
    const schema = z.object({ statuses: z.array(z.enum(['online', 'idle', 'dnd'])).default(['online']) });
    expect(parseSettingsForm(schema, { 'cfg.statuses.__set': '1', 'cfg.statuses': ['online', 'dnd'] }, {})).toEqual({ statuses: ['online', 'dnd'] });
    expect(parseSettingsForm(schema, { 'cfg.statuses.__set': '1', 'cfg.statuses': 'idle' }, {})).toEqual({ statuses: ['idle'] });
    expect(parseSettingsForm(schema, { 'cfg.statuses.__set': '1' }, {})).toEqual({ statuses: [] });
    expect(parseSettingsForm(schema, {}, {})).toEqual({});
  });
});

describe('web app', () => {
  it('serves the dashboard, instance pages and saves settings', async () => {
    const { registry, hub, logs } = setup();
    await registry.ensureInstances([{ plugin: 'test-source', enabled: true }]);
    await registry.startAll();
    const app = createWebApp({ registry, hub, logs, env: { publicUrl: undefined }, uiPassword: undefined });

    const dash = await app.request('/');
    expect(dash.status).toBe(200);
    expect(await dash.text()).toContain('Watching Plex: Hello');

    const page = await (await app.request('/instances/test-source')).text();
    expect(page).toContain('API key');
    expect(page).not.toContain('kept-secret');

    const body = new URLSearchParams({ 'cfg.title': 'From form', 'cfg.count': '2', label: 'Mine' });
    const save = await app.request('/instances/test-source/settings', {
      method: 'POST',
      body,
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(save.status).toBe(302);
    expect(registry.get('test-source')?.label).toBe('Mine');
    expect(hub.get('test-source')?.activity.title).toBe('From form');
  });

  it('shows defaults for settings added after the config was saved', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srpc-test-'));
    dirs.push(dir);
    // A config saved by an older version, before `on` and `tags` existed.
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ version: 1, instances: [{ id: 'old', plugin: 'test-source', enabled: false, config: { title: 'Saved' } }] }),
    );
    const hub = new Hub();
    const logs = new LogBuffer();
    const registry = new Registry({
      plugins: [testSource],
      config: new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig),
      state: new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({})),
      hub,
      log: new Logger(logs, 'test', 'error'),
      env: { publicUrl: undefined },
    });
    const app = createWebApp({ registry, hub, logs, env: { publicUrl: undefined }, uiPassword: undefined });
    const page = await (await app.request('/instances/old')).text();
    expect(page).toMatch(/name="cfg\.on" checked/); // default true, not unticked
    expect(page).toContain('value="3"'); // count's default
    expect(page).toContain('value="Saved"');
  });

  it('rejects cross-site form posts and requires the password when set', async () => {
    const { registry, hub, logs } = setup();
    const app = createWebApp({ registry, hub, logs, env: { publicUrl: undefined }, uiPassword: 'pw' });
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/')).status).toBe(401);
    const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` };
    expect((await app.request('/', { headers: auth })).status).toBe(200);
    const res = await app.request('/instances', {
      method: 'POST',
      body: new URLSearchParams({ plugin: 'test-source' }),
      headers: { ...auth, Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(403);
  });
});
