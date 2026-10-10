import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Hub, type HubState } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { defineOutput, defineSource, type OutputContext, type SourceContext } from '../src/core/plugin.js';
import { Registry, emptyConfig, type AppConfig } from '../src/core/registry.js';
import { JsonStore } from '../src/core/store.js';
import { movie } from './helpers.js';

const dirs: string[] = [];
const hubs: Hub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function setup(initial?: AppConfig, options: { failStop?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-hub-'));
  dirs.push(dir);
  if (initial) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(initial));
  const hub = new Hub();
  hubs.push(hub);
  const started: string[] = [];
  const contexts = new Map<string, SourceContext<{ identity: string }>>();
  const outputContexts = new Map<string, OutputContext<Record<string, never>>>();
  const states: HubState[] = [];
  const source = defineSource({
    id: 'source', name: 'Source', description: '', multiple: true, configSchema: z.object({ identity: z.string().default('default') }),
    create: (ctx) => {
      contexts.set(ctx.instanceId, ctx);
      return {
        start: () => { started.push(ctx.instanceId); ctx.publish(movie({ key: ctx.instanceId })); },
        stop() {},
        status: () => ({ health: 'ok', message: 'Playing' }),
      };
    },
  });
  const output = defineOutput({
    id: 'discord', name: 'Discord', description: '', configSchema: z.object({}),
    create: (ctx) => {
      outputContexts.set(ctx.instanceId, ctx);
      return {
        start() {},
        stop() {
          if (options.failStop) throw new Error('Withdrawal failed');
          ctx.reportShown(null);
        },
        status: () => ({ health: 'idle', message: 'Connected' }),
        onState: (state) => { states.push(state); ctx.reportShown(state.selected); },
      };
    },
  });
  const config = new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig);
  const registry = new Registry({
    plugins: [source, output], config,
    state: new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({})),
    hub, log: new Logger(new LogBuffer(), 'test', 'error'), env: { publicUrl: undefined },
  });
  return { registry, config, hub, states, started, contexts, outputContexts, dir };
}

describe('Registry hub integration', () => {
  it('persists retention and rejects invalid values without changing settings', async () => {
    const { registry, config } = setup();
    expect(registry.historyRetention()).toBe(90);
    await registry.saveHistoryRetention(365);
    expect(registry.historyRetention()).toBe(365);
    expect(JSON.parse(fs.readFileSync(config.file, 'utf8')).history).toEqual({ retentionDays: 365 });
    for (const days of [0, 3651, 1.5, NaN]) {
      await expect(registry.saveHistoryRetention(days)).rejects.toThrow('whole number');
    }
    expect(config.get().history).toEqual({ retentionDays: 365 });
  });
  it('reorders source priority without restarting sources and persists it', async () => {
    const { registry, config, hub, states, started } = setup();
    await registry.ensureInstances([{ plugin: 'source', enabled: true }, { plugin: 'discord', enabled: true }]);
    const second = await registry.add('source');
    await registry.setEnabled(second, true);
    await registry.startAll();
    expect(hub.snapshot().selected?.sourceId).toBe('source');
    const before = [...started];
    await registry.move(second, 0);
    expect(registry.sources().map((source) => source.id)).toEqual([second, 'source']);
    expect(config.get().instances.map((instance) => instance.id)).toEqual([second, 'discord', 'source']);
    expect(hub.snapshot().selected?.sourceId).toBe(second);
    expect(states.at(-1)?.selected?.sourceId).toBe(second);
    expect(started).toEqual(before);
    expect(JSON.parse(fs.readFileSync(config.file, 'utf8')).instances[0].id).toBe(second);
    await expect(registry.move('discord', 0)).rejects.toThrow('Not a source');
    await expect(registry.move(second, -1)).rejects.toThrow('non-negative');
    await expect(registry.move(second, 10)).rejects.toThrow('outside');
  });

  it('persists the legacy migration before sources and outputs start', async () => {
    const { registry, config, hub } = setup({ version: 1, instances: [
      { id: 'source', plugin: 'source', enabled: true, config: {} },
      { id: 'discord', plugin: 'discord', enabled: true, config: { sourcePriority: ['source-2'], paused: 'show', quietHours: '', timeZone: 'UTC' } },
      { id: 'source-2', plugin: 'source', enabled: true, config: {} },
    ] });
    await registry.startAll();
    expect(hub.snapshot().selected?.sourceId).toBe('source-2');
    expect(config.get().hub).toEqual({ paused: 'show', quietHours: '', timeZone: 'UTC' });
    expect(config.get().instances[1]!.config).toEqual({});
    expect(JSON.parse(fs.readFileSync(config.file, 'utf8')).hub.paused).toBe('show');
  });

  it('inherits unspecified output rules and changes selection without restarting', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-08T12:30:00Z') });
    const { registry, hub, states, config, started } = setup();
    await registry.ensureInstances([{ plugin: 'source', enabled: true }, { plugin: 'discord', enabled: true }]);
    await registry.startAll();
    const before = [...started];
    await registry.saveHubRules({ paused: 'hide', quietHours: '', timeZone: 'UTC' });
    hub.set('source', movie({ paused: true }));
    expect(states.at(-1)?.selected).toBeNull();
    expect(await registry.saveRules('discord', { paused: 'show' })).toEqual({ ok: true });
    expect(config.get().instances[1]!.rules).toEqual({ paused: 'show' });
    expect(states.at(-1)?.selected?.sourceId).toBe('source');
    expect(hub.snapshot().selected).toBeNull();
    await registry.saveHubRules({ paused: 'hide', quietHours: '12:00-13:00', timeZone: 'UTC' });
    expect(states.at(-1)).toMatchObject({ selected: null, selectionReason: 'Quiet hours (12:00-13:00)' });
    expect(states.at(-1)?.activities).toHaveLength(1);
    await registry.saveRules('discord', undefined);
    expect(config.get().instances[1]!.rules).toBeUndefined();
    expect(started).toEqual(before);
    expect((await registry.saveRules('discord', { timeZone: 'invalid' })).ok).toBe(false);
  });

  it('tracks only explicitly reported successful operations and closes output history on stop', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { registry, hub, contexts } = setup();
    const history = { recordSource: vi.fn(), recordShown: vi.fn() };
    hub.attachHistory(history);
    await registry.ensureInstances([{ plugin: 'source', enabled: true }, { plugin: 'discord', enabled: true }]);
    await registry.startAll();
    expect(registry.get('source')?.status.lastSuccessAt).toBeUndefined();
    contexts.get('source')!.reportSuccess!();
    expect(registry.get('source')?.status.lastSuccessAt).toBe(1_000_000);
    contexts.get('source')!.publish(null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(registry.get('source')?.status.lastSuccessAt).toBe(1_000_000);
    await registry.setEnabled('discord', false);
    expect(history.recordShown).toHaveBeenLastCalledWith('discord', null, 1_005_000);
    await registry.setEnabled('source', false);
    contexts.get('source')!.reportSuccess!();
    expect(registry.get('source')?.status.lastSuccessAt).toBe(1_000_000);
  });

  it('retains a prior successful check on restart and invalidates it when settings change', async () => {
    const { registry, contexts } = setup();
    await registry.ensureInstances([{ plugin: 'source', enabled: true }]);
    await registry.startAll();
    contexts.get('source')!.reportSuccess!();
    const lastSuccess = registry.get('source')!.status.lastSuccessAt;
    await registry.restart('source');
    expect(registry.get('source')!.status.lastSuccessAt).toBe(lastSuccess);
    await registry.saveConfig('source', { identity: 'new endpoint' });
    expect(registry.get('source')!.status.lastSuccessAt).toBeUndefined();
  });

  it('does not claim an unsuccessful withdrawal cleared the displayed activity', async () => {
    const { registry, hub, outputContexts } = setup(undefined, { failStop: true });
    const history = { recordSource: vi.fn(), recordShown: vi.fn() };
    hub.attachHistory(history);
    await registry.ensureInstances([{ plugin: 'source', enabled: true }, { plugin: 'discord', enabled: true }]);
    await registry.startAll();
    history.recordShown.mockClear();
    await registry.setEnabled('discord', false);
    expect(history.recordShown).not.toHaveBeenCalled();
    outputContexts.get('discord')!.reportShown(null);
    expect(history.recordShown).not.toHaveBeenCalled();
  });

  it('accepts confirmed clears during stop but rejects stale reports after a restart', async () => {
    const { registry, hub, outputContexts } = setup();
    const history = { recordSource: vi.fn(), recordShown: vi.fn() };
    hub.attachHistory(history);
    await registry.ensureInstances([{ plugin: 'source', enabled: true }, { plugin: 'discord', enabled: true }]);
    await registry.startAll();
    const previous = outputContexts.get('discord')!;
    history.recordShown.mockClear();
    await registry.restart('discord');
    expect(history.recordShown.mock.calls.some((call) => call[0] === 'discord' && call[1] === null)).toBe(true);
    history.recordShown.mockClear();
    previous.reportShown(null);
    previous.reportShown(hub.snapshot().selected);
    expect(history.recordShown).not.toHaveBeenCalled();
  });
});
