import type { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { z } from 'zod';
import type { NowPlaying } from './activity.js';
import type { HubState } from './hub.js';
import type { Logger } from './log.js';
import type { ScopedState } from './store.js';

/**
 * Plugins come in two kinds:
 * - a **source** (input) watches some service and publishes what's playing;
 * - an **output** receives every source's current activity and does something with it.
 *
 * A plugin is a definition; the user configures one or more *instances* of it. Each instance gets
 * its own config, state slice, logger and web routes, and is restarted when its config changes.
 */

export type InstanceHealth = 'ok' | 'idle' | 'setup' | 'warning' | 'error';

export interface InstanceStatus {
  health: InstanceHealth;
  /** One-line summary for the dashboard. */
  message: string;
}

export interface AppEnv {
  /** Externally reachable base URL of the web UI (no trailing slash), if configured. */
  publicUrl: string | undefined;
  /** Directory for persistent data; plugins may keep caches in subdirectories. */
  dataDir?: string;
}

export interface BaseContext<C> {
  instanceId: string;
  config: C;
  log: Logger;
  /** Persistent runtime state for this instance (tokens, session ids, ...). */
  state: ScopedState<Record<string, unknown>>;
  env: AppEnv;
  /** Aborted when the instance stops. */
  signal: AbortSignal;
  /** URL path under which this instance's `routes` are mounted, e.g. `/plugins/discord`. */
  routeBase: string;
  /** URL path under which this instance's `publicRoutes` are mounted, e.g. `/public/tautulli`. */
  publicBase: string;
}

export interface SourceContext<C> extends BaseContext<C> {
  publish(activity: NowPlaying | null): void;
}

export interface OutputContext<C> extends BaseContext<C> {
  /** Every source instance, in configured order, for outputs that rank them. */
  sources(): SourceInfo[];
}

export interface SourceInfo {
  id: string;
  label: string;
  enabled: boolean;
}

export interface PanelProps {
  /** Path of this instance's settings page, for forms that redirect back. */
  pagePath: string;
  /** Origin of the current request (or PUBLIC_URL), for showing absolute URLs. */
  origin: string;
}

export interface Instance {
  start(): void | Promise<void>;
  /** Clean up: stop timers, withdraw anything published. */
  stop(): void | Promise<void>;
  status(): InstanceStatus;
  /** Register extra web routes, mounted under `ctx.routeBase`. */
  routes?(app: Hono): void;
  /**
   * Register routes that must be reachable without the UI password (e.g. images fetched by
   * Discord, or incoming webhooks), mounted under `ctx.publicBase`. Authenticate them yourself.
   */
  publicRoutes?(app: Hono): void;
  /** Plugin-specific UI shown on the instance page above the settings form (forms, actions). */
  panel?(props: PanelProps): Child;
  /** Read-only status UI that the instance page re-renders every few seconds. */
  live?(props: PanelProps): Child;
}

export interface OutputInstance extends Instance {
  onState(state: HubState): void;
}

interface PluginBase<C> {
  /** Stable plugin type id, used in config files, e.g. `discord`. */
  id: string;
  name: string;
  description: string;
  /**
   * Settings, rendered as a form. Use `.meta({ title, description })` on fields for labels and
   * `.meta({ secret: true })` for write-only fields such as API keys. Every field needs a default
   * so a new instance can be created before it's configured.
   */
  configSchema: z.ZodObject;
  /** Whether more than one instance may exist. */
  multiple?: boolean;
  /** Not used by the core; lets TypeScript infer `C` from the schema. */
  readonly _config?: C;
}

export interface SourcePlugin<C = unknown> extends PluginBase<C> {
  kind: 'source';
  create(ctx: SourceContext<C>): Instance;
}

export interface OutputPlugin<C = unknown> extends PluginBase<C> {
  kind: 'output';
  create(ctx: OutputContext<C>): OutputInstance;
}

export type Plugin = SourcePlugin<any> | OutputPlugin<any>;

export function defineSource<S extends z.ZodObject>(
  plugin: Omit<SourcePlugin<z.infer<S>>, 'configSchema' | 'kind'> & { configSchema: S },
): SourcePlugin<z.infer<S>> {
  return { ...plugin, kind: 'source' };
}

export function defineOutput<S extends z.ZodObject>(
  plugin: Omit<OutputPlugin<z.infer<S>>, 'configSchema' | 'kind'> & { configSchema: S },
): OutputPlugin<z.infer<S>> {
  return { ...plugin, kind: 'output' };
}
