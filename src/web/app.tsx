import fs from 'node:fs';
import { createRequire } from 'node:module';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { describeActivity } from '../core/activity.js';
import type { Controls } from '../core/controls.js';
import type { Hub } from '../core/hub.js';
import type { LogBuffer, LogEntry } from '../core/log.js';
import type { AppEnv, PanelProps } from '../core/plugin.js';
import type { InstanceView, Registry } from '../core/registry.js';
import { Auth, newSessionSecret, SESSION_COOKIE, SESSION_TTL_MS } from './auth.js';
import { issuesByField, parseSettingsForm, SettingsFields } from './forms.js';
import { APPLE_TOUCH_ICON, ICON } from './icon.js';
import { Health, Layout, LoginPage, Notice, timeAgo } from './layout.js';

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

  const origin = (c: Context) => env.publicUrl ?? new URL(c.req.url).origin;

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

  // ---- dashboard -------------------------------------------------------------------------------
  const Dashboard = () => {
    const views = registry.list();
    const sources = views.filter((v) => v.plugin?.kind === 'source');
    const outputs = views.filter((v) => v.plugin?.kind === 'output');
    const pause = opts.controls?.pauseInfo();
    return (
      <div hx-get="/partials/dashboard" hx-trigger="every 3s" hx-swap="outerHTML">
        {opts.controls && (
          <div class={`card ${pause?.paused ? 'paused' : ''}`}>
            {pause?.paused ? (
              <form class="actions" style="margin: 0" method="post" action="/resume">
                <strong>Publishing is paused</strong>
                <span class="muted">{pause.until ? `until ${new Date(pause.until).toLocaleString()}` : 'until you resume'}</span>
                <button>Resume</button>
              </form>
            ) : (
              <form class="actions" style="margin: 0" method="post" action="/pause">
                <span>Pause publishing:</span>
                {PAUSE_OPTIONS.map(([label, minutes]) => (
                  <button class="secondary" name="minutes" value={minutes === undefined ? '' : String(minutes)}>
                    {label}
                  </button>
                ))}
              </form>
            )}
          </div>
        )}
        <div class="card">
          <h2>Sources</h2>
          <InstanceTable views={sources} activity={(v) => hub.get(v.config.id)?.activity} />
        </div>
        <div class="card">
          <h2>Outputs</h2>
          <InstanceTable views={outputs} />
        </div>
        <div class="card">
          <h2>Recent log</h2>
          <LogTable entries={logs.recent(12)} />
          <p class="small">
            <a href="/log">Full log</a>
          </p>
        </div>
      </div>
    );
  };

  app.get('/', (c) => {
    const addable = registry
      .plugins()
      .filter((p) => p.multiple || !registry.list().some((v) => v.config.plugin === p.id));
    return c.html(
      <Layout title="Dashboard">
        <h1>Dashboard</h1>
        <Dashboard />
        {addable.length > 0 && (
          <form class="card" method="post" action="/instances">
            <h2>Add</h2>
            <select name="plugin">
              {addable.map((p) => (
                <option value={p.id}>
                  {p.kind === 'source' ? 'Source' : 'Output'}: {p.name} ({p.description})
                </option>
              ))}
            </select>
            <div class="actions">
              <button>Add</button>
            </div>
          </form>
        )}
      </Layout>,
    );
  });
  app.get('/partials/dashboard', (c) => c.html(<Dashboard />));

  app.get('/log', (c) =>
    c.html(
      <Layout title="Log">
        <h1>Log</h1>
        <div class="card">
          <LogTable entries={logs.recent(500)} />
        </div>
      </Layout>,
    ),
  );

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

  const instancePage = (c: Context, view: InstanceView, extra?: { errors?: Record<string, string>; values?: Record<string, unknown> }) => {
    const id = view.config.id;
    const pagePath = `/instances/${id}`;
    const props: PanelProps = { pagePath, origin: origin(c) };
    const notice = NOTICES[c.req.query('notice') ?? ''] ?? c.req.query('message');
    const error = c.req.query('error');
    const plugin = view.plugin;
    return c.html(
      <Layout title={view.label}>
        <h1>
          {view.label} <span class="muted small">{plugin ? `${plugin.kind} · ${plugin.name}` : view.config.plugin} · id <code>{id}</code></span>
        </h1>
        {notice && <Notice kind="ok">{notice}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        {extra?.errors && <Notice kind="error">Some settings are invalid; see below.</Notice>}
        <div hx-get={`${pagePath}/live`} hx-trigger="every 3s" hx-swap="innerHTML">
          <LiveBlock view={view} props={props} />
        </div>
        {view.live?.instance.panel?.(props)}
        {plugin && (
          <form class="card" method="post" action={`${pagePath}/settings`}>
            <h2>Settings</h2>
            <label>
              Label
              <div class="help">Display name for this {plugin.kind}.</div>
              <input type="text" name="label" value={view.config.label ?? ''} placeholder={plugin.name} />
            </label>
            <SettingsFields schema={plugin.configSchema} values={extra?.values ?? effectiveConfig(view)} errors={extra?.errors} />
            <div class="actions">
              <button>Save{view.config.enabled ? ' and restart' : ''}</button>
            </div>
          </form>
        )}
        <div class="card actions">
          <form class="inline" method="post" action={`${pagePath}/${view.config.enabled ? 'disable' : 'enable'}`}>
            <button class={view.config.enabled ? 'secondary' : ''}>{view.config.enabled ? 'Disable' : 'Enable'}</button>
          </form>
          {view.config.enabled && (
            <form class="inline" method="post" action={`${pagePath}/restart`}>
              <button class="secondary">Restart</button>
            </form>
          )}
          <form class="inline" method="post" action={`${pagePath}/remove`} onsubmit="return confirm('Remove this instance and its saved state?')">
            <button class="danger">Remove</button>
          </form>
        </div>
      </Layout>,
      extra?.errors ? 400 : 200,
    );
  };

  const withView = (handler: (c: Context, view: InstanceView) => Response | Promise<Response>) => (c: Context) => {
    const view = registry.get(c.req.param('id') ?? '');
    if (!view) return c.html(<Layout title="Not found"><Notice kind="error">No such instance.</Notice><a href="/">Back</a></Layout>, 404);
    return handler(c, view);
  };

  app.get('/instances/:id', withView((c, view) => instancePage(c, view)));
  app.get(
    '/instances/:id/live',
    withView((c, view) => c.html(<LiveBlock view={view} props={{ pagePath: `/instances/${view.config.id}`, origin: origin(c) }} />)),
  );
  app.post(
    '/instances/:id/settings',
    withView(async (c, view) => {
      if (!view.plugin) return c.text('Unknown plugin', 400);
      // `all`: repeated fields (checkbox groups) arrive as arrays.
      const form = await c.req.parseBody({ all: true });
      const raw = parseSettingsForm(view.plugin.configSchema, form, effectiveConfig(view));
      const result = await registry.saveConfig(view.config.id, raw, String(form.label ?? ''));
      if (!result.ok) return instancePage(c, view, { errors: issuesByField(result.issues), values: { ...effectiveConfig(view), ...raw } });
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
    instances: registry.list().map((v) => ({
      id: v.config.id,
      kind: v.plugin?.kind,
      plugin: v.config.plugin,
      label: v.label,
      enabled: v.config.enabled,
      health: v.status.health,
      message: v.status.message,
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

function LiveBlock(props: { view: InstanceView; props: PanelProps }) {
  const { view } = props;
  return (
    <>
      <div class="card">
        <Health health={view.status.health} message={view.status.message} />
      </div>
      {view.live?.instance.live?.(props.props)}
    </>
  );
}

function InstanceTable(props: { views: InstanceView[]; activity?: (v: InstanceView) => import('../core/activity.js').NowPlaying | undefined }) {
  if (!props.views.length) return <p class="muted">None yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
          {props.activity && <th>Current activity</th>}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {props.views.map((v) => {
          const a = props.activity?.(v);
          return (
            <tr>
              <td>
                <a href={`/instances/${v.config.id}`}>{v.label}</a>
                <div class="small muted">{v.config.id}</div>
              </td>
              <td>
                <Health health={v.status.health} message={v.status.message} />
              </td>
              {props.activity && <td>{a ? describeActivity(a) : <span class="muted">-</span>}</td>}
              <td style="text-align: right">
                <form class="inline" method="post" action={`/instances/${v.config.id}/${v.config.enabled ? 'disable' : 'enable'}`}>
                  <input type="hidden" name="return" value="/" />
                  <button class="secondary small">{v.config.enabled ? 'Disable' : 'Enable'}</button>
                </form>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
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
