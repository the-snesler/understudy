import { Hono } from 'hono';
import type { z } from 'zod';
import type { NowPlaying } from './activity.js';
import type { Hub } from './hub.js';
import { errorMessage, type Logger } from './log.js';
import type {
  AppEnv,
  Instance,
  InstanceStatus,
  OutputInstance,
  Plugin,
  SourceInfo,
} from './plugin.js';
import { ScopedState, type JsonStore } from './store.js';

export interface InstanceConfig {
  id: string;
  plugin: string;
  enabled: boolean;
  /** Display name; defaults to the plugin name. */
  label?: string;
  config: Record<string, unknown>;
}

export interface AppConfig {
  version: 1;
  instances: InstanceConfig[];
}

export const emptyConfig = (): AppConfig => ({ version: 1, instances: [] });

interface Live {
  instance: Instance;
  abort: AbortController;
  app: Hono;
  publicApp: Hono;
  unsubscribe?: () => void;
}

export interface InstanceView {
  config: InstanceConfig;
  plugin: Plugin | undefined;
  label: string;
  routeBase: string;
  status: InstanceStatus;
  live: Live | undefined;
}

export type SaveResult = { ok: true } | { ok: false; issues: z.core.$ZodIssue[] };

/** Owns the configured instances: creates, starts, stops and restarts them, and wires them to the hub. */
export class Registry {
  private readonly pluginsById: Map<string, Plugin>;
  private readonly live = new Map<string, Live>();
  private readonly failures = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly opts: {
      plugins: Plugin[];
      config: JsonStore<AppConfig>;
      state: JsonStore<Record<string, unknown>>;
      hub: Hub;
      log: Logger;
      env: AppEnv;
    },
  ) {
    this.pluginsById = new Map(opts.plugins.map((p) => [p.id, p]));
  }

  plugins(): Plugin[] {
    return [...this.pluginsById.values()];
  }

  plugin(id: string): Plugin | undefined {
    return this.pluginsById.get(id);
  }

  list(): InstanceView[] {
    return this.opts.config.get().instances.map((cfg) => this.view(cfg));
  }

  get(id: string): InstanceView | undefined {
    const cfg = this.opts.config.get().instances.find((i) => i.id === id);
    return cfg && this.view(cfg);
  }

  sources(): SourceInfo[] {
    return this.list()
      .filter((v) => v.plugin?.kind === 'source')
      .map((v) => ({ id: v.config.id, label: v.label, enabled: v.config.enabled }));
  }

  /**
   * Add an instance of each listed plugin on first run. Does nothing once a config file exists, so
   * instances the user removed stay removed.
   */
  ensureInstances(defaults: { plugin: string; enabled: boolean }[]): Promise<void> {
    return this.serial(async () => {
      if (this.opts.config.existed) return;
      for (const d of defaults) {
        if (this.opts.config.get().instances.some((i) => i.plugin === d.plugin)) continue;
        await this.addConfig(d.plugin, d.enabled);
      }
    });
  }

  startAll(): Promise<void> {
    return this.serial(async () => {
      for (const cfg of this.opts.config.get().instances) {
        if (cfg.enabled) await this.startInstance(cfg);
      }
    });
  }

  stopAll(): Promise<void> {
    return this.serial(async () => {
      for (const id of [...this.live.keys()].reverse()) await this.stopInstance(id);
    });
  }

  add(pluginId: string): Promise<string> {
    return this.serial(async () => {
      const plugin = this.pluginsById.get(pluginId);
      if (!plugin) throw new Error(`Unknown plugin ${pluginId}`);
      const exists = this.opts.config.get().instances.some((i) => i.plugin === pluginId);
      if (exists && !plugin.multiple) throw new Error(`${plugin.name} can only be added once`);
      return this.addConfig(pluginId, false);
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      await this.stopInstance(id);
      await this.opts.config.update((c) => ({ ...c, instances: c.instances.filter((i) => i.id !== id) }));
      await new ScopedState(this.opts.state, id).set(undefined);
      this.failures.delete(id);
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.serial(async () => {
      const cfg = await this.patch(id, (c) => ({ ...c, enabled }));
      await this.stopInstance(id);
      if (enabled) await this.startInstance(cfg);
    });
  }

  /** Validate and save settings, then restart the instance if it's enabled. */
  saveConfig(id: string, raw: Record<string, unknown>, label?: string): Promise<SaveResult> {
    return this.serial(async () => {
      const view = this.get(id);
      if (!view?.plugin) throw new Error(`Unknown instance ${id}`);
      const parsed = view.plugin.configSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, issues: parsed.error.issues };
      const cfg = await this.patch(id, (c) => ({
        ...c,
        config: parsed.data as Record<string, unknown>,
        ...(label !== undefined ? { label: label.trim() || undefined } : {}),
      }));
      if (cfg.enabled) {
        await this.stopInstance(id);
        await this.startInstance(cfg);
      }
      return { ok: true };
    });
  }

  /** Restart a running instance with its current settings. */
  restart(id: string): Promise<void> {
    return this.serial(async () => {
      const cfg = this.opts.config.get().instances.find((i) => i.id === id);
      if (!cfg) return;
      await this.stopInstance(id);
      if (cfg.enabled) await this.startInstance(cfg);
    });
  }

  private view(cfg: InstanceConfig): InstanceView {
    const plugin = this.pluginsById.get(cfg.plugin);
    const live = this.live.get(cfg.id);
    let status: InstanceStatus;
    if (!plugin) status = { health: 'error', message: `Unknown plugin "${cfg.plugin}"` };
    else if (this.failures.has(cfg.id)) status = { health: 'error', message: this.failures.get(cfg.id)! };
    else if (!cfg.enabled) status = { health: 'idle', message: 'Disabled' };
    else if (live) status = safeStatus(live.instance);
    else status = { health: 'idle', message: 'Not running' };
    return {
      config: cfg,
      plugin,
      label: cfg.label || plugin?.name || cfg.plugin,
      routeBase: `/plugins/${cfg.id}`,
      status,
      live,
    };
  }

  private async addConfig(pluginId: string, enabled: boolean): Promise<string> {
    const plugin = this.pluginsById.get(pluginId)!;
    const taken = new Set(this.opts.config.get().instances.map((i) => i.id));
    let id = pluginId;
    for (let n = 2; taken.has(id); n++) id = `${pluginId}-${n}`;
    const config = plugin.configSchema.parse({}) as Record<string, unknown>;
    await this.opts.config.update((c) => ({
      ...c,
      instances: [...c.instances, { id, plugin: pluginId, enabled, config }],
    }));
    return id;
  }

  private async patch(id: string, fn: (c: InstanceConfig) => InstanceConfig): Promise<InstanceConfig> {
    let updated: InstanceConfig | undefined;
    await this.opts.config.update((c) => ({
      ...c,
      instances: c.instances.map((i) => (i.id === id ? (updated = fn(i)) : i)),
    }));
    if (!updated) throw new Error(`Unknown instance ${id}`);
    return updated;
  }

  private async startInstance(cfg: InstanceConfig): Promise<void> {
    const plugin = this.pluginsById.get(cfg.plugin);
    if (!plugin) return;
    this.failures.delete(cfg.id);
    const log = this.opts.log.child(cfg.id);
    const parsed = plugin.configSchema.safeParse(cfg.config);
    if (!parsed.success) {
      const msg = `Invalid settings: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      this.failures.set(cfg.id, msg);
      log.error(msg);
      return;
    }

    const abort = new AbortController();
    const routeBase = `/plugins/${cfg.id}`;
    const publicBase = `/public/${cfg.id}`;
    const base = {
      instanceId: cfg.id,
      config: parsed.data,
      log,
      state: new ScopedState<Record<string, unknown>>(this.opts.state, cfg.id),
      env: this.opts.env,
      signal: abort.signal,
      routeBase,
      publicBase,
    };

    try {
      let instance: Instance;
      let unsubscribe: (() => void) | undefined;
      if (plugin.kind === 'source') {
        const hub = this.opts.hub;
        instance = plugin.create({
          ...base,
          publish: (activity: NowPlaying | null) => {
            if (!abort.signal.aborted) hub.set(cfg.id, activity);
          },
        });
      } else {
        const output: OutputInstance = plugin.create({ ...base, sources: () => this.sources() });
        instance = output;
        const deliver = (state: Parameters<OutputInstance['onState']>[0]) => {
          try {
            output.onState(state);
          } catch (err) {
            log.error(`onState failed: ${errorMessage(err)}`);
          }
        };
        unsubscribe = this.opts.hub.subscribe(deliver);
        queueMicrotask(() => {
          if (!abort.signal.aborted) deliver(this.opts.hub.snapshot());
        });
      }
      const app = new Hono().basePath(routeBase);
      instance.routes?.(app);
      const publicApp = new Hono().basePath(publicBase);
      instance.publicRoutes?.(publicApp);
      this.live.set(cfg.id, { instance, abort, app, publicApp, unsubscribe });
      await instance.start();
      log.info('started');
    } catch (err) {
      const msg = `Failed to start: ${errorMessage(err)}`;
      this.failures.set(cfg.id, msg);
      log.error(msg);
      await this.stopInstance(cfg.id);
    }
  }

  private async stopInstance(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    live.unsubscribe?.();
    live.abort.abort();
    try {
      await live.instance.stop();
    } catch (err) {
      this.opts.log.child(id).error(`stop failed: ${errorMessage(err)}`);
    }
    this.opts.hub.set(id, null);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function safeStatus(instance: Instance): InstanceStatus {
  try {
    return instance.status();
  } catch (err) {
    return { health: 'error', message: errorMessage(err) };
  }
}
