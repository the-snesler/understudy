import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Hub } from '../src/core/hub.js';
import { Logger, LogBuffer } from '../src/core/log.js';
import { defineSource } from '../src/core/plugin.js';
import { migrateAppConfig, Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore } from '../src/core/store.js';
import { createWebApp } from '../src/web/app.js';
import { tautulliPlugin } from '../src/plugins/tautulli/index.js';
import { jellyfinPlugin } from '../src/plugins/jellyfin/index.js';
import { createTraktPlugin } from '../src/plugins/trakt/index.js';

const dirs: string[] = [];
const registries: Registry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.stopAll();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const initial = (): AppConfig => ({ version: 1, instances: [
  { id: 'plex', plugin: 'tautulli', enabled: true, config: { tmdbKey: ' first ', tmdbEnabled: false } },
  { id: 'jellyfin', plugin: 'jellyfin', enabled: true, config: { tmdbKey: 'second' } },
  { id: 'trakt', plugin: 'trakt', enabled: false, config: { tmdbKey: '' } },
  { id: 'other', plugin: 'other', enabled: true, config: { tmdbKey: 'unrelated' } },
] });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-settings-'));
  dirs.push(dir);
  const config = new JsonStore<AppConfig>(path.join(dir, 'config.json'), initial);
  const seen: Record<string, string[]> = {};
  const stopped: string[] = [];
  const plugins = ['tautulli', 'jellyfin', 'trakt', 'other'].map((id) => defineSource({
    id, name: id, description: '', configSchema: z.object({}),
    create: (ctx) => ({
      start() { (seen[id] ??= []).push(ctx.sharedSettings!.tmdbKey); },
      stop() { stopped.push(id); },
      status: () => ({ health: 'idle', message: '' }),
    }),
  }));
  const hub = new Hub();
  const logs = new LogBuffer();
  const registry = new Registry({ plugins, config, hub, log: new Logger(logs, 'test', 'error'),
    state: new JsonStore(path.join(dir, 'state.json'), () => ({})), env: { publicUrl: undefined } });
  registries.push(registry);
  const app = createWebApp({ registry, hub, logs, env: { publicUrl: undefined }, uiPassword: undefined });
  return { config, registry, seen, stopped, app };
}

describe('shared TMDB settings', () => {
  it('migrates the first nonempty legacy key, removes duplicates, and preserves unrelated fields', () => {
    const migrated = migrateAppConfig(initial(), ['plex', 'jellyfin', 'trakt', 'other']);
    expect(migrated.shared).toEqual({ tmdbKey: 'first' });
    expect(migrated.instances[0]!.config).toEqual({ tmdbEnabled: false });
    expect(migrated.instances[1]!.config).toEqual({});
    expect(migrated.instances[3]!.config).toEqual({ tmdbKey: 'unrelated' });
    expect(migrateAppConfig(migrated, ['plex', 'jellyfin', 'trakt', 'other'])).toBe(migrated);
    expect(migrateAppConfig({ ...initial(), shared: { tmdbKey: '' } }, []).shared).toEqual({ tmdbKey: '' });
  });

  it('supplies the key to sources, persists updates, and restarts only enabled consumers', async () => {
    const { config, registry, seen, stopped } = setup();
    await registry.startAll();
    expect(seen.tautulli).toEqual(['first']);
    expect(seen.jellyfin).toEqual(['first']);
    expect(await registry.saveSharedSettings({ tmdbKey: ' replacement ' })).toEqual({ ok: true });
    expect(seen.tautulli).toEqual(['first', 'replacement']);
    expect(seen.jellyfin).toEqual(['first', 'replacement']);
    expect(seen.other).toEqual(['first']);
    expect(seen.trakt).toBeUndefined();
    expect(stopped).toEqual(['tautulli', 'jellyfin']);
    expect(JSON.parse(fs.readFileSync(config.file, 'utf8')).shared).toEqual({ tmdbKey: 'replacement' });
    await registry.saveSharedSettings({ tmdbKey: 'replacement' });
    expect(stopped).toHaveLength(2);
    expect((await registry.saveSharedSettings({ tmdbKey: 123 })).ok).toBe(false);
    expect(registry.sharedSettings().tmdbKey).toBe('replacement');
    await registry.setEnabled('trakt', true);
    expect(seen.trakt).toEqual(['replacement']);
  });

  it('renders a write-only key and supports keeping, replacing, and removing it', async () => {
    const { app, registry } = setup();
    await registry.startAll();
    const html = await (await app.request('/settings')).text();
    expect(html).toContain('Shared artwork');
    expect(html).toContain('name="cfg.tmdbKey"');
    expect(html).not.toContain('value="first"');
    const post = (values: Record<string, string>) => app.request('/settings/shared', {
      method: 'POST', body: new URLSearchParams(values),
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect((await post({ 'cfg.tmdbKey': '' })).status).toBe(302);
    expect(registry.sharedSettings().tmdbKey).toBe('first');
    await post({ 'cfg.tmdbKey': 'new' });
    expect(registry.sharedSettings().tmdbKey).toBe('new');
    await post({ clearTmdbKey: 'on' });
    expect(registry.sharedSettings().tmdbKey).toBe('');
  });

  it('removes the credential from all three plugin forms while preserving the Plex switch', () => {
    for (const plugin of [tautulliPlugin, jellyfinPlugin, createTraktPlugin()]) {
      expect(plugin.configSchema.shape.tmdbKey).toBeUndefined();
    }
    expect(tautulliPlugin.configSchema.shape.tmdbEnabled).toBeDefined();
  });
});
