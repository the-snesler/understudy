import type { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { z } from 'zod';
import type { NowPlaying, SourceActivity } from './activity.js';
import type { HistoryObservation, HistoryQuery, HistorySegment, ImportedEntry, ImportResult } from './history.js';
import type { HubState } from './hub.js';
import type { Logger } from './log.js';
import type { SharedSettings } from './shared-settings.js';
import type { ScopedState } from './store.js';

/**
 * Plugins come in three kinds:
 * - a **source** (input) watches some service and publishes what's playing now. The Hub picks one
 *   activity from all sources for the outputs, and history records every source;
 * - a **history source** copies past or background activity from another service (a calendar,
 *   your Discord status) into history. It never reaches the Hub, so no output shows it live;
 * - an **output** receives the Hub's selection and does something with it, such as setting your
 *   Discord status or publishing a calendar feed of your history.
 *
 * A plugin is a definition; the user configures one or more *instances* of it. Each instance gets
 * its own config, state slice, logger and web routes, and is restarted when its config changes.
 *
 * **The no-echo rule.** Activity never goes back to the service it came from. A history source
 * and an output that share a `service` are kept apart: the Calendar feed leaves out events
 * imported from calendars, and the Discord output never shows statuses recorded from Discord. The
 * registry enforces this for outputs' history queries, and history sources also skip what
 * Understudy itself published there (Understudy's own feed events and Discord activity), so
 * subscribing a calendar to the feed, or importing that calendar, can never loop.
 */

export type InstanceHealth = 'ok' | 'idle' | 'setup' | 'warning' | 'error';

export interface InstanceStatus {
  health: InstanceHealth;
  /** One-line summary for the dashboard. */
  message: string;
  /** Epoch ms of the last successful connection check, poll, or output send. */
  lastSuccessAt?: number;
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
  /** Shared service credentials, supplied by the registry. */
  sharedSettings?: SharedSettings;
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
  /** Call after a successful external operation, including a successful poll with no activity. */
  reportSuccess?(): void;
}

export interface SourceContext<C> extends BaseContext<C> {
  publish(activity: NowPlaying | null): void;
}

export interface OutputContext<C> extends BaseContext<C> {
  /** Every source instance, in configured order, for outputs that rank them. */
  sources(): SourceInfo[];
  /** Confirm what the output actually shows, after its own gates and successful updates. */
  reportShown(activity: SourceActivity | null): void;
  /** Recorded history, without entries from this output's own service. Absent without storage. */
  history?: HistoryReader;
}

/** Writes for a history source, already scoped to its instance id and service. */
export interface HistoryWriter {
  /** What the service shows right now; entries no longer listed end now. */
  observe(items: HistoryObservation[]): void;
  /** Replace the imported entries starting within the window, e.g. one calendar refresh. */
  importEntries(window: { from: number; to: number }, entries: ImportedEntry[]): ImportResult;
  /** This source's most recent entries, newest first. */
  recent(limit: number): HistorySegment[];
  /** Delete everything this source recorded. */
  clear(): number;
}

export interface HistorySourceContext<C> extends BaseContext<C> {
  history: HistoryWriter;
  /** The Hub's time zone, for times that don't carry their own. */
  timeZone(): string;
}

/** Read access for outputs that publish history. The no-echo rule is already applied. */
export interface HistoryReader {
  query(options?: HistoryQuery): HistorySegment[];
  /** The Hub's time zone. */
  timeZone(): string;
  /** A source's display label, or its id once it has been removed. */
  label(sourceId: string): string;
  /** The app-wide feed token from before feeds were outputs, if this install has one. */
  legacyFeedToken(): string | undefined;
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
  /** Runtime suggestions and connection notes supplied to the schema-driven settings form. */
  formContext?(props: PanelProps): { suggestions?: Record<string, string[]>; notes?: Record<string, Child> };
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
  /**
   * The outside service this plugin reads from or writes to, e.g. `discord` or `calendar`. A
   * history source's entries never reach an output with the same service (the no-echo rule).
   */
  service?: string;
  /** Not used by the core; lets TypeScript infer `C` from the schema. */
  readonly _config?: C;
}

export interface SourcePlugin<C = unknown> extends PluginBase<C> {
  kind: 'source';
  create(ctx: SourceContext<C>): Instance;
}

export interface OutputPlugin<C = unknown> extends PluginBase<C> {
  kind: 'output';
  /**
   * `live` (the default) outputs show the Hub's selection, under the Hub's rules. `history` outputs,
   * such as feeds, publish recorded history on request; selection rules don't apply to them.
   */
  publishes?: 'live' | 'history';
  create(ctx: OutputContext<C>): OutputInstance;
}

export interface HistorySourcePlugin<C = unknown> extends PluginBase<C> {
  kind: 'history';
  create(ctx: HistorySourceContext<C>): Instance;
}

export type Plugin = SourcePlugin<any> | HistorySourcePlugin<any> | OutputPlugin<any>;
export type PluginKind = Plugin['kind'];

export function defineSource<S extends z.ZodObject>(
  plugin: Omit<SourcePlugin<z.infer<S>>, 'configSchema' | 'kind'> & { configSchema: S },
): SourcePlugin<z.infer<S>> {
  return { ...plugin, kind: 'source' };
}

export function defineHistorySource<S extends z.ZodObject>(
  plugin: Omit<HistorySourcePlugin<z.infer<S>>, 'configSchema' | 'kind'> & { configSchema: S },
): HistorySourcePlugin<z.infer<S>> {
  return { ...plugin, kind: 'history' };
}

export function defineOutput<S extends z.ZodObject>(
  plugin: Omit<OutputPlugin<z.infer<S>>, 'configSchema' | 'kind'> & { configSchema: S },
): OutputPlugin<z.infer<S>> {
  return { ...plugin, kind: 'output' };
}
