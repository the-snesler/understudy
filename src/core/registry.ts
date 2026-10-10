import { Hono } from 'hono';
import type { z } from 'zod';
import { stableStringify, type NowPlaying } from './activity.js';
import { defaultHubRules, hubRulesSchema, type Hub, type HubRules } from './hub.js';
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
  /** Output-only selection overrides; omitted fields inherit the hub's current rules. */
  rules?: Partial<HubRules>;
}

export interface AppConfig {
  version: 1;
  instances: InstanceConfig[];
  /** Optional when reading pre-hub configuration; migration writes a complete value. */
  hub?: HubRules;
  history?: { retentionDays: number };
}

export const emptyConfig = (): AppConfig => ({ version: 1, hub: defaultHubRules(), instances: [] });

const LEGACY_RULE_FIELDS = ['sourcePriority', 'paused', 'quietHours', 'timeZone'] as const;

/** One-time conversion from Discord-owned selection rules to shared hub rules and source order. */
export function migrateAppConfig(config: AppConfig, sourceIds: string[]): AppConfig {
  const discord = config.instances.find((instance) => instance.plugin === 'discord');
  const legacyRules = (instance: InstanceConfig | undefined): Partial<HubRules> =>
    Object.fromEntries(['paused', 'quietHours', 'timeZone'].flatMap((key) =>
      instance && instance.config[key] !== undefined ? [[key, instance.config[key]]] : [],
    )) as Partial<HubRules>;
  const hub = hubRulesSchema.parse({ ...legacyRules(discord), ...config.hub });
  const priority = Array.isArray(discord?.config.sourcePriority) ? discord.config.sourcePriority : [];
  const ids = new Set(sourceIds);
  const sources = config.instances.filter((instance) => ids.has(instance.id));
  const rank = (id: string) => {
    const index = priority.indexOf(id);
    return index < 0 ? priority.length : index;
  };
  // Stable sorting preserves the previous order of unlisted sources and the positions of outputs.
  sources.sort((a, b) => rank(a.id) - rank(b.id));
  let nextSource = 0;
  const instances = config.instances.map((original) => {
    const instance = ids.has(original.id) ? sources[nextSource++]! : original;
    if (instance.plugin !== 'discord') return instance;
    const overrides = Object.fromEntries(Object.entries(legacyRules(instance)).filter(([key, value]) =>
      value !== hub[key as keyof HubRules],
    ));
    const cleaned = Object.fromEntries(Object.entries(instance.config).filter(([key]) =>
      !LEGACY_RULE_FIELDS.includes(key as typeof LEGACY_RULE_FIELDS[number]),
    ));
    return {
      ...instance,
      config: cleaned,
      ...(Object.keys(overrides).length ? { rules: { ...overrides, ...instance.rules } } : {}),
    };
  });
  const migrated = { ...config, hub, instances };
  return JSON.stringify(migrated) === JSON.stringify(config) ? config : migrated;
}

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
  private readonly successes = new Map<string, number>();
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
    this.refreshHub(migrateAppConfig(opts.config.get(), this.sources().map((source) => source.id)));
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

  hubRules(): HubRules {
    return hubRulesSchema.parse(migrateAppConfig(this.opts.config.get(), this.sources().map((source) => source.id)).hub ?? {});
  }

  historyRetention(): number {
    const days = this.opts.config.get().history?.retentionDays;
    return days !== undefined && Number.isInteger(days) && days >= 1 && days <= 3650 ? days : 90;
  }

  saveHistoryRetention(days: number): Promise<void> {
    return this.serial(async () => {
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new Error('History retention must be a whole number from 1 to 3650 days');
      }
      await this.opts.config.update((config) => ({ ...config, history: { retentionDays: days } }));
    });
  }

  saveHubRules(raw: Record<string, unknown>): Promise<SaveResult> {
    return this.serial(async () => {
      const parsed = hubRulesSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, issues: parsed.error.issues };
      await this.opts.config.update((config) => ({ ...config, hub: parsed.data }));
      this.refreshHub();
      return { ok: true };
    });
  }

  saveRules(id: string, rules: Partial<HubRules> | undefined): Promise<SaveResult> {
    return this.serial(async () => {
      const view = this.get(id);
      if (view?.plugin?.kind !== 'output') throw new Error(`Not an output instance: ${id}`);
      const parsed = hubRulesSchema.partial().safeParse(rules ?? {});
      if (!parsed.success) return { ok: false, issues: parsed.error.issues };
      const overrides = Object.fromEntries(Object.entries(parsed.data).filter(([key]) =>
        rules?.[key as keyof HubRules] !== undefined,
      )) as Partial<HubRules>;
      await this.patch(id, (config) => {
        const { rules: _previous, ...rest } = config;
        return rules === undefined ? rest : { ...rest, rules: overrides };
      });
      this.refreshHub();
      return { ok: true };
    });
  }

  /** Move within the source list; output positions remain stable. No source needs restarting. */
  move(id: string, index: number): Promise<void> {
    return this.serial(async () => {
      if (!Number.isInteger(index) || index < 0) throw new Error('Priority index must be a non-negative integer');
      const ids = new Set(this.sources().map((source) => source.id));
      if (!ids.has(id)) throw new Error(`Not a source instance: ${id}`);
      await this.opts.config.update((config) => {
        const sources = config.instances.filter((instance) => ids.has(instance.id));
        if (index >= sources.length) throw new Error('Priority index is outside the source list');
        const from = sources.findIndex((source) => source.id === id);
        const [moved] = sources.splice(from, 1);
        sources.splice(index, 0, moved!);
        let next = 0;
        return { ...config, instances: config.instances.map((instance) => ids.has(instance.id) ? sources[next++]! : instance) };
      });
      this.refreshHub();
    });
  }

  /**
   * Add an instance of each listed plugin on first run. Does nothing once a config file exists, so
   * instances the user removed stay removed.
   */
  ensureInstances(defaults: { plugin: string; enabled: boolean }[]): Promise<void> {
    return this.serial(async () => {
      await this.migrate();
      if (this.opts.config.existed) return;
      for (const d of defaults) {
        if (this.opts.config.get().instances.some((i) => i.plugin === d.plugin)) continue;
        await this.addConfig(d.plugin, d.enabled);
      }
    });
  }

  startAll(): Promise<void> {
    return this.serial(async () => {
      await this.migrate();
      this.opts.hub.start();
      for (const cfg of this.opts.config.get().instances) {
        if (cfg.enabled) await this.startInstance(cfg);
      }
    });
  }

  stopAll(): Promise<void> {
    return this.serial(async () => {
      for (const id of [...this.live.keys()].reverse()) await this.stopInstance(id);
      this.opts.hub.stop();
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
      this.successes.delete(id);
      this.refreshHub();
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.serial(async () => {
      const cfg = await this.patch(id, (c) => ({ ...c, enabled }));
      await this.stopInstance(id);
      this.refreshHub();
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
      if (stableStringify(view.config.config) !== stableStringify(parsed.data)) this.successes.delete(id);
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
    status = { ...status, lastSuccessAt: status.lastSuccessAt ?? this.successes.get(cfg.id) };
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
    this.refreshHub();
    return id;
  }

  private async migrate(): Promise<void> {
    const config = this.opts.config.get();
    const migrated = migrateAppConfig(config, this.sources().map((source) => source.id));
    if (migrated !== config) await this.opts.config.update(() => migrated);
    this.refreshHub();
  }

  private refreshHub(config = this.opts.config.get()): void {
    const sources = config.instances.filter((instance) => this.pluginsById.get(instance.plugin)?.kind === 'source')
      .map((instance) => ({ id: instance.id, label: instance.label || this.pluginsById.get(instance.plugin)!.name, enabled: instance.enabled }));
    this.opts.hub.configure(hubRulesSchema.parse(config.hub ?? {}), sources);
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
      reportSuccess: () => {
        if (!abort.signal.aborted) this.successes.set(cfg.id, Date.now());
      },
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
        const output: OutputInstance = plugin.create({
          ...base,
          sources: () => this.sources(),
          reportShown: (activity) => {
            // A successful withdrawal during stop is still evidence. Reject callbacks from older
            // generations once a replacement instance is running under the same id.
            if (!abort.signal.aborted || (activity === null && this.live.get(cfg.id)?.abort === abort)) {
              this.opts.hub.reportShown(cfg.id, activity);
            }
          },
        });
        instance = output;
        const deliver = (state: Parameters<OutputInstance['onState']>[0]) => {
          try {
            const rules = this.opts.config.get().instances.find((instance) => instance.id === cfg.id)?.rules;
            output.onState(rules ? this.opts.hub.snapshot(rules) : state);
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
    live.unsubscribe?.();
    live.abort.abort();
    try {
      await live.instance.stop();
    } catch (err) {
      this.opts.log.child(id).error(`stop failed: ${errorMessage(err)}`);
    } finally {
      this.live.delete(id);
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
