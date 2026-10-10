import fs from 'node:fs';
import { createRequire } from 'node:module';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { stableStringify } from '../core/activity.js';
import type { HistoryStore } from '../core/history.js';
import { hubRulesSchema, type HubRules } from '../core/hub.js';
import type { ScopedState } from '../core/store.js';
import type { Controls } from '../core/controls.js';
import type { Hub } from '../core/hub.js';
import type { LogBuffer, LogEntry } from '../core/log.js';
import type { AppEnv, PanelProps } from '../core/plugin.js';
import type { InstanceView, Registry } from '../core/registry.js';
import { Auth, newSessionSecret, SESSION_COOKIE, SESSION_TTL_MS } from './auth.js';
import { registerAssets } from './assets.js';
import { issuesByField, parseSettingsForm, SettingsFields } from './forms.js';
import { APPLE_TOUCH_ICON, ICON } from './icon.js';
import { Health, Layout, LoginPage, Notice, PublishingCard, timeAgo } from './layout.js';
import { Dashboard, FeedsCard, RecentEvents, ToggleForm } from './dashboard.js';
import { Icon, PluginIcon } from './icons.js';
import { registerHistoryRoutes } from './history.js';
import { HubSettings, OutputRulesCard, SaveBar } from './settings.js';

const require = createRequire(import.meta.url);
const HTMX = fs.readFileSync(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8');

const NOTICES: Record<string, string> = {
  saved: 'Settings saved.',
  connected: 'Connected to Discord.',
  disconnected: 'Disconnected.',
  resent: 'Re-sent.',
  set: 'Activity set.',
  cleared: 'Activity cleared.',
  added: 'Added. Configure it below, then enable it.',
};

export interface WebOptions {
  registry: Registry;
  hub: Hub;
  logs: LogBuffer;
  env: AppEnv;
  uiPassword: string | undefined;
  /** Signs session cookies. Persist it so sign-ins survive restarts; random if omitted. */
  sessionSecret?: string;
  /** App-wide controls (pause). Optional so tests can omit it. */
  controls?: Controls;
  history?: HistoryStore;
  preferences?: ScopedState<{ attentionDismissedAt?: number }>;
}

/**
 * The settings an instance actually runs with: saved values plus defaults for anything added since
 * they were saved. The form must show these, or new options would look unset (and be saved unset).
 */
function effectiveConfig(view: InstanceView): Record<string, unknown> {
  const parsed = view.plugin?.configSchema.safeParse(view.config.config);
  return parsed?.success ? (parsed.data as Record<string, unknown>) : view.config.config;
}

/** Only allow redirects back to our own pages. */
function safeReturn(value: unknown): string | undefined {
  const v = typeof value === 'string' ? value : '';
  return v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : undefined;
}

const PAUSE_OPTIONS: [string, number | undefined][] = [
  ['30 minutes', 30],
  ['1 hour', 60],
  ['4 hours', 240],
  ['Until I resume', undefined],
];

export function createWebApp(opts: WebOptions): Hono {
  const { registry, hub, logs, env } = opts;
  const app = new Hono();
  // Lets the layout see whether the request is signed in.
  app.use('*', contextStorage());
  registerAssets(app);
  app.use('*', async (c, next) => {
    c.set('pauseInfo', opts.controls?.pauseInfo());
    c.set('hasControls', !!opts.controls);
    await next();
  });

  const origin = (c: Context) => env.publicUrl ?? new URL(c.req.url).origin;
  if (opts.history) registerHistoryRoutes(app, opts.history, { timeZone: () => registry.hubRules().timeZone });
  let dismissedAt = opts.preferences?.get()?.attentionDismissedAt ?? 0;

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/static/htmx.min.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(HTMX);
  });
  app.get('/favicon.svg', (c) => {
    c.header('Content-Type', 'image/svg+xml');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(ICON);
  });
  app.get('/apple-touch-icon.png', (c) => {
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(APPLE_TOUCH_ICON);
  });

  // Plugin routes that must work without the UI password (images for Discord, webhooks).
  app.all('/public/:id/*', (c) => {
    const view = registry.get(c.req.param('id'));
    if (!view?.live) return c.text('Not found', 404);
    return view.live.publicApp.fetch(c.req.raw);
  });

  if (opts.uiPassword) {
    const auth = new Auth(opts.uiPassword, opts.sessionSecret ?? newSessionSecret());

    const clientOf = (c: Context) => {
      try {
        return getConnInfo(c).remote.address ?? 'unknown';
      } catch {
        return 'unknown'; // not served by @hono/node-server (tests)
      }
    };
    const startSession = (c: Context) =>
      setCookie(c, SESSION_COOKIE, auth.issue(), {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: origin(c).startsWith('https:') || c.req.header('x-forwarded-proto') === 'https',
        maxAge: SESSION_TTL_MS / 1000,
      });
    const lockedMessage = (ms: number) => `Too many wrong passwords. Try again in ${Math.ceil(ms / 60_000)} minutes.`;
    const loginPath = (next: string | undefined) => {
      const n = safeReturn(next);
      return n && n !== '/' && !n.startsWith('/login') ? `/login?next=${encodeURIComponent(n)}` : '/login';
    };

    app.get('/login', (c) => {
      if (auth.verify(getCookie(c, SESSION_COOKIE))) return c.redirect(safeReturn(c.req.query('next')) ?? '/');
      return c.html(<LoginPage next={safeReturn(c.req.query('next'))} />);
    });
    app.post('/login', csrf(), async (c) => {
      const form = await c.req.parseBody();
      const next = safeReturn(form.next);
      const client = clientOf(c);
      const locked = auth.lockedFor(client);
      if (locked) return c.html(<LoginPage next={next} error={lockedMessage(locked)} />, 429);
      if (!auth.checkPassword(String(form.password ?? ''))) {
        auth.recordFailure(client);
        return c.html(<LoginPage next={next} error="Wrong password." />, 401);
      }
      startSession(c);
      return c.redirect(next && !next.startsWith('/login') ? next : '/', 303);
    });

    app.use('*', async (c, next) => {
      const expires = auth.verify(getCookie(c, SESSION_COOKIE));
      if (expires) {
        if (expires - Date.now() < SESSION_TTL_MS / 2) startSession(c);
        c.set('signedIn', true);
        return next();
      }
      // The JSON API also takes the password as basic auth (any username), for automations.
      if (c.req.path.startsWith('/api/')) {
        const header = c.req.header('authorization') ?? '';
        if (header.startsWith('Basic ')) {
          const client = clientOf(c);
          const locked = auth.lockedFor(client);
          if (locked) return c.json({ error: lockedMessage(locked) }, 429);
          const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
          if (auth.checkPassword(decoded.slice(decoded.indexOf(':') + 1))) return next();
          auth.recordFailure(client);
        }
        c.header('WWW-Authenticate', 'Basic realm="understudy", charset="UTF-8"');
        return c.json({ error: 'Unauthorized' }, 401);
      }
      // htmx polling after the session ended: send the whole page to the sign-in screen.
      if (c.req.header('hx-request')) {
        const current = c.req.header('hx-current-url');
        c.header('HX-Redirect', loginPath(current ? new URL(current, c.req.url).pathname : undefined));
        return c.body(null, 401);
      }
      const url = new URL(c.req.url);
      return c.redirect(loginPath(c.req.method === 'GET' ? url.pathname + url.search : undefined), 303);
    });

    app.post('/logout', csrf(), (c) => {
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.redirect('/login', 303);
    });
  }
  // API POSTs must be JSON: browsers send saved basic-auth credentials even on cross-site requests, and a
  // cross-site form can't send application/json, so this keeps the API safe from forged requests.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && !(c.req.header('content-type') ?? '').startsWith('application/json')) {
      return c.json({ error: 'Send Content-Type: application/json' }, 415);
    }
    await next();
  });
  app.use('*', csrf());

  // ---- overview and app settings ------------------------------------------------------------
  const dashboard = (c: Context) => <Dashboard registry={registry} hub={hub} logs={logs} history={opts.history} origin={origin(c)} dismissedAt={dismissedAt} />;
  app.get('/', (c) => c.html(<Layout title="Overview">{dashboard(c)}</Layout>));
  app.get('/partials/dashboard', (c) => c.html(dashboard(c)));
  app.get('/partials/publishing', (c) => c.html(<PublishingCard pause={opts.controls?.pauseInfo()} available={!!opts.controls} />));
  app.post('/attention/dismiss', async (c) => {
    const form = await c.req.parseBody();
    const at = Number(form.through);
    if (!Number.isFinite(at) || at < 0) return c.text('Invalid dismissal timestamp', 400);
    dismissedAt = Math.max(dismissedAt, Math.min(at, Date.now()));
    await opts.preferences?.set({ ...opts.preferences.get(), attentionDismissedAt: dismissedAt });
    return c.redirect('/');
  });
  app.get('/timeline', (c) => c.html(<Layout title="Timeline"><div class="page-header"><h1>Timeline</h1></div><section class="card stub"><Icon name="activity" size={36} /><h2>Your activity, over time</h2><p class="muted">Activity history is being recorded. The timeline view is coming next. Today’s totals and history feeds are available on the Overview.</p><a class="btn" href="/">Back to Overview</a></section></Layout>));
  app.get('/settings', (c) => c.html(<Layout title="Settings"><div class="page-header"><h1>Settings</h1></div>{c.req.query('notice') && <Notice kind="ok">{c.req.query('notice') === 'regenerated' ? 'New feed links created. Previous links no longer work.' : 'Settings saved.'}</Notice>}<div class="plugin-grid"><div><section class="card"><div class="flex items-center gap-3 mb-3"><span class="hub-icon"><Icon name="hub" size={18} /></span><h2>Hub rules</h2></div><p class="muted small">Choose how paused media and quiet hours affect your activity.</p><a class="btn mt-4" href="/settings/hub">Edit Hub rules</a></section><form class="card" action="/settings/history" method="post"><h2>History retention</h2><p class="muted small mt-1">Activity stays on this server. Older completed segments are deleted automatically.</p><label class="mt-4" for="retention">Keep history for (days)</label><input id="retention" name="retentionDays" type="number" min="1" max="3650" value={registry.historyRetention()} required /><button class="btn primary mt-4">Save retention</button></form>{opts.history && <section class="card"><h2>Feed access</h2><p class="muted small mt-1">Anyone with a feed link can read your history. Regenerating links revokes the old ones.</p><form method="post" action="/settings/feeds/regenerate" class="mt-4"><button class="btn"><Icon name="restart" size={15} />Regenerate links</button></form></section>}</div><aside class="aside-column"><FeedsCard history={opts.history} origin={origin(c)} /></aside></div></Layout>));
  const hubSettings = (c: Context, extra?: { errors?: Record<string, string>; values?: Record<string, unknown> }) => c.html(<Layout title="Hub rules"><div class="breadcrumb"><a href="/settings">Settings</a><span>/</span><span>Hub rules</span></div><div class="page-header"><h1>Hub rules</h1></div>{c.req.query('notice') && <Notice kind="ok">Rules saved.</Notice>}{extra?.errors && <Notice kind="error">Some rules are invalid; see below.</Notice>}<div class="max-w-3xl"><HubSettings registry={registry} {...extra} /></div></Layout>);
  app.get('/settings/hub', (c) => hubSettings(c));
  app.post('/settings/hub', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const raw = parseSettingsForm(hubRulesSchema, form, registry.hubRules());
    const result = await registry.saveHubRules(raw);
    if (!result.ok) return hubSettings(c, { errors: issuesByField(result.issues), values: raw });
    return c.redirect('/settings/hub?notice=saved');
  });
  app.post('/settings/history', async (c) => {
    const days = Number((await c.req.parseBody()).retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return c.text('Retention must be between 1 and 3650 days', 400);
    await registry.saveHistoryRetention(days);
    opts.history?.setRetention(days);
    return c.redirect('/settings?notice=saved');
  });
  app.post('/settings/feeds/regenerate', (c) => {
    if (!opts.history) return c.text('History is not available', 501);
    opts.history.regenerateToken();
    return c.redirect('/settings?notice=regenerated');
  });
  app.get('/log', (c) => c.html(<Layout title="Log"><div class="page-header"><h1>Log</h1><span class="small muted">Recent events from every source and output</span></div><div class="card log-table-wrapper"><LogTable entries={logs.recent(500)} /></div></Layout>));
  app.get('/instances/new', (c) => {
    const kind = c.req.query('kind') === 'output' ? 'output' : 'source';
    const addable = registry.plugins().filter((p) => p.kind === kind && (p.multiple || !registry.list().some((v) => v.config.plugin === p.id)));
    return c.html(<Layout title={`Add ${kind}`}><div class="breadcrumb"><a href="/">Overview</a><span>/</span><span>Add {kind}</span></div><div class="page-header"><h1>Add {kind}</h1></div><div class="max-w-2xl">{addable.length ? addable.map((plugin) => <form class="card flex items-center gap-4" method="post" action="/instances"><PluginIcon plugin={plugin.id} /><div class="flex-1"><h2>{plugin.name}</h2><p class="muted small mt-1">{plugin.description}</p></div><button class="btn" name="plugin" value={plugin.id}><Icon name="plus" size={15} />Add</button></form>) : <section class="card"><p class="muted">All available {kind}s have been added.</p><a href="/">Back to Overview</a></section>}</div></Layout>);
  });
  app.post('/instances/reorder', async (c) => {
    try {
      const input = (c.req.header('content-type') ?? '').startsWith('application/json') ? await c.req.json() : await c.req.parseBody();
      if (Array.isArray(input.ids)) {
        const current = registry.sources().map((source) => source.id);
        const ids = input.ids;
        if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id: unknown) => typeof id !== 'string' || !current.includes(id))) return c.json({ error: 'Send every source ID exactly once' }, 400);
        for (let index = 0; index < ids.length; index++) await registry.move(ids[index], index);
      } else {
        const index = Number(input.index);
        if (typeof input.id !== 'string' || !Number.isInteger(index)) return c.json({ error: 'Send a source id and index' }, 400);
        await registry.move(input.id, index);
      }
      return c.json({ ids: registry.sources().map((source) => source.id) });
    } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });

  // ---- instances -------------------------------------------------------------------------------
  app.post('/instances', async (c) => {
    const form = await c.req.parseBody();
    try {
      const id = await registry.add(String(form.plugin ?? ''));
      return c.redirect(`/instances/${id}?notice=added`);
    } catch (err) {
      return c.html(
        <Layout title="Add">
          <Notice kind="error">{(err as Error).message}</Notice>
          <a href="/">Back</a>
        </Layout>,
        400,
      );
    }
  });

  const instancePage = (c: Context, view: InstanceView, extra?: { errors?: Record<string, string>; values?: Record<string, unknown>; rulesValues?: Partial<HubRules> }) => {
    const id = view.config.id;
    const pagePath = `/instances/${id}`;
    const props: PanelProps = { pagePath, origin: origin(c) };
    const notice = NOTICES[c.req.query('notice') ?? ''] ?? c.req.query('message');
    const error = c.req.query('error');
    const plugin = view.plugin;
    const labelField = <div class="field"><label for="instance-label" class="field-label">Label</label><input id="instance-label" type="text" name="label" value={view.config.label ?? ''} placeholder={plugin?.name} /></div>;
    const labelGroup = plugin?.id === 'tautulli' ? 'Connection' : plugin?.id === 'discord' ? 'Discord application' : 'Settings';
    const outputRules = plugin?.kind === 'output' ? <OutputRulesCard registry={registry} view={view} values={extra?.rulesValues} error={extra?.errors?._rules} /> : undefined;
    const saveMessage = plugin?.kind === 'output' ? 'Saving reconnects this output.' : 'Saving restarts this source.';
    return c.html(<Layout title={view.label}>
      <div class="breadcrumb"><a href="/">Overview</a><span>/</span><span>{plugin?.kind === 'output' ? 'Outputs' : 'Sources'}</span><span>/</span><span>{view.label}</span></div>
      <div class="page-header plugin-heading"><div class="plugin-title"><PluginIcon plugin={view.config.plugin} large /><div><div class="plugin-title-line"><h1>{view.label}</h1><span hx-get={`${pagePath}/status`} hx-trigger="every 3s" hx-swap="innerHTML"><Health health={view.status.health} message={view.status.message} pill /></span></div><p>{plugin?.kind === 'output' ? 'Output' : 'Source'} · {plugin?.name ?? view.config.plugin} · <code>{id}</code>{plugin?.kind === 'source' && ` · priority ${registry.sources().findIndex((source) => source.id === id) + 1}`}</p></div></div><div class="actions top">
        {view.live && (plugin?.id === 'discord' ? <form method="post" action={`${view.routeBase}/resend`}><button class="btn"><Icon name="send" size={15} />Re-send now</button></form> : ['tautulli', 'jellyfin', 'steam', 'scrobbler', 'trakt'].includes(plugin?.id ?? '') && <form method="post" action={`${view.routeBase}/test`}><input name="return" type="hidden" value={pagePath} /><button class="btn"><Icon name="zap" size={15} />Test connection</button></form>)}
        <form method="post" action={`${pagePath}/restart`}><button class="btn"><Icon name="restart" size={15} />Restart</button></form><div class="btn"><span>Enabled</span><ToggleForm view={view} returnTo={pagePath} /></div><details class="menu"><summary class="btn icon-only" aria-label="More actions"><Icon name="ellipsis" /></summary><div class="menu-popover"><form method="post" action={`${pagePath}/remove`}><button class="btn danger"><Icon name="trash" size={15} />Remove {plugin?.kind ?? 'instance'}</button></form></div></details>
      </div></div>
      {notice && <Notice kind="ok">{notice}</Notice>}{error && <Notice kind="error">{error}</Notice>}{extra?.errors && <Notice kind="error">Some settings are invalid; see below.</Notice>}
      <div class="plugin-grid"><div>{view.live?.instance.panel?.(props)}{plugin && <form class="settings-form" method="post" action={`${pagePath}/settings`} data-save-message={saveMessage}>
        <SettingsFields schema={plugin.configSchema} values={extra?.values ?? effectiveConfig(view)} errors={extra?.errors} previewUrl={plugin.id === 'tautulli' && view.live ? `${view.routeBase}/template-preview` : undefined} context={view.live?.instance.formContext?.(props)} groupExtras={{ [labelGroup]: labelField }} afterGroups={plugin.id === 'discord' ? { 'When to show': outputRules } : undefined} />
        {plugin.kind === 'output' && plugin.id !== 'discord' && outputRules}
        <SaveBar message={saveMessage} />
      </form>}</div><aside class="aside-column" hx-get={`${pagePath}/live`} hx-trigger="every 3s" hx-swap="innerHTML"><LiveBlock view={view} props={props} entries={logs.recent(6, id)} /></aside></div>
    </Layout>);
  };

  const withView = (handler: (c: Context, view: InstanceView) => Response | Promise<Response>) => (c: Context) => {
    const view = registry.get(c.req.param('id') ?? '');
    if (!view) return c.html(<Layout title="Not found"><Notice kind="error">No such instance.</Notice><a href="/">Back</a></Layout>, 404);
    return handler(c, view);
  };

  app.get('/instances/:id', withView((c, view) => instancePage(c, view)));
  app.get('/instances/:id/status', withView((c, view) => c.html(<Health health={view.status.health} message={view.status.message} pill />)));
  app.get(
    '/instances/:id/live',
    withView((c, view) => c.html(<LiveBlock view={view} props={{ pagePath: `/instances/${view.config.id}`, origin: origin(c) }} entries={logs.recent(6, view.config.id)} />)),
  );
  app.post(
    '/instances/:id/settings',
    withView(async (c, view) => {
      if (!view.plugin) return c.text('Unknown plugin', 400);
      // `all`: repeated fields (checkbox groups) arrive as arrays.
      const form = await c.req.parseBody({ all: true });
      const raw = parseSettingsForm(view.plugin.configSchema, form, effectiveConfig(view));
      const rules = form.rulesEnabled === 'on' ? hubRulesSchema.safeParse({ paused: form['rules.paused'], quietHours: form['rules.quietHours'], timeZone: form['rules.timeZone'] }) : undefined;
      if (rules && !rules.success) return instancePage(c, view, { errors: { _rules: rules.error.issues.map((issue) => issue.message).join('; ') }, values: raw, rulesValues: { paused: String(form['rules.paused']) as HubRules['paused'], quietHours: String(form['rules.quietHours'] ?? ''), timeZone: String(form['rules.timeZone'] ?? '') } });
      const parsed = view.plugin.configSchema.safeParse(raw);
      if (!parsed.success) return instancePage(c, view, { errors: issuesByField(parsed.error.issues), values: raw });
      const label = String(form.label ?? view.config.label ?? '').trim() || undefined;
      if (stableStringify(parsed.data) !== stableStringify(effectiveConfig(view)) || label !== view.config.label) {
        const result = await registry.saveConfig(view.config.id, parsed.data as Record<string, unknown>, label ?? '');
        if (!result.ok) return instancePage(c, view, { errors: issuesByField(result.issues), values: raw });
      }
      if (view.plugin.kind === 'output') await registry.saveRules(view.config.id, rules?.success ? rules.data : undefined);
      return c.redirect(`/instances/${view.config.id}?notice=saved`);
    }),
  );
  app.post('/instances/:id/enable', withView(async (c, view) => {
    await registry.setEnabled(view.config.id, true);
    return c.redirect(safeReturn((await c.req.parseBody()).return) ?? `/instances/${view.config.id}`);
  }));
  app.post('/instances/:id/disable', withView(async (c, view) => {
    await registry.setEnabled(view.config.id, false);
    return c.redirect(safeReturn((await c.req.parseBody()).return) ?? `/instances/${view.config.id}`);
  }));

  // ---- pause -----------------------------------------------------------------------------------
  const minutesFrom = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  app.post('/pause', async (c) => {
    await opts.controls?.pause(minutesFrom((await c.req.parseBody()).minutes));
    return c.redirect('/');
  });
  app.post('/resume', async (c) => {
    await opts.controls?.resume();
    return c.redirect('/');
  });

  // ---- JSON API, for automations (e.g. Home Assistant). Uses the same password as the UI. ------
  const statusJson = () => ({
    pause: opts.controls?.pauseInfo() ?? { paused: false },
    selected: hub.snapshot().selected,
    selectionReason: hub.snapshot().selectionReason,
    instances: registry.list().map((v) => ({
      id: v.config.id,
      kind: v.plugin?.kind,
      plugin: v.config.plugin,
      label: v.label,
      enabled: v.config.enabled,
      health: v.status.health,
      message: v.status.message,
      lastSuccessAt: v.status.lastSuccessAt,
      activity: v.plugin?.kind === 'source' ? (hub.get(v.config.id)?.activity ?? null) : undefined,
    })),
  });
  app.get('/api/status', (c) => c.json(statusJson()));
  app.post('/api/pause', async (c) => {
    if (!opts.controls) return c.json({ error: 'not available' }, 501);
    const body = (await c.req.json().catch(() => ({}))) as { minutes?: unknown };
    return c.json({ pause: await opts.controls.pause(minutesFrom(body.minutes ?? c.req.query('minutes'))) });
  });
  app.post('/api/resume', async (c) => {
    if (!opts.controls) return c.json({ error: 'not available' }, 501);
    return c.json({ pause: await opts.controls.resume() });
  });
  app.post('/api/toggle', async (c) => {
    if (!opts.controls) return c.json({ error: 'not available' }, 501);
    const paused = opts.controls.pauseInfo().paused;
    return c.json({ pause: paused ? await opts.controls.resume() : await opts.controls.pause() });
  });
  app.post('/instances/:id/restart', withView(async (c, view) => {
    await registry.restart(view.config.id);
    return c.redirect(`/instances/${view.config.id}`);
  }));
  app.post('/instances/:id/remove', withView(async (c, view) => {
    await registry.remove(view.config.id);
    return c.redirect('/');
  }));

  // ---- plugin routes ---------------------------------------------------------------------------
  app.all('/plugins/:id/*', (c) => {
    const view = registry.get(c.req.param('id'));
    if (!view?.live) return c.html(<Layout title="Unavailable"><Notice kind="error">This instance isn't running. Enable it first.</Notice><a href="/">Back</a></Layout>, 404);
    return view.live.app.fetch(c.req.raw);
  });

  return app;
}

function LiveBlock({ view, props, entries }: { view: InstanceView; props: PanelProps; entries: LogEntry[] }) {
  return <>{view.live?.instance.live?.(props) ?? <section class="card"><h2>Live status</h2><p class="mt-3"><Health health={view.status.health} message={view.status.message} /></p>{view.status.lastSuccessAt && <p class="muted small">Last success {timeAgo(view.status.lastSuccessAt)}</p>}</section>}<RecentEvents entries={entries} /></>;
}

function LogTable(props: { entries: LogEntry[] }) {
  if (!props.entries.length) return <p class="muted">Nothing logged yet.</p>;
  return (
    <table class="log">
      <tbody>
        {props.entries.map((e) => (
          <tr class={`lvl-${e.level}`}>
            <td title={new Date(e.at).toISOString()}>{timeAgo(e.at)}</td>
            <td>{e.scope}</td>
            <td>{e.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
