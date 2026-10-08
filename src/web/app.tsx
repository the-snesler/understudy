import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { csrf } from 'hono/csrf';
import { describeActivity } from '../core/activity.js';
import type { Hub } from '../core/hub.js';
import type { LogBuffer, LogEntry } from '../core/log.js';
import type { AppEnv, PanelProps } from '../core/plugin.js';
import type { InstanceView, Registry } from '../core/registry.js';
import { issuesByField, parseSettingsForm, SettingsFields } from './forms.js';
import { Health, Layout, Notice, timeAgo } from './layout.js';

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
}

export function createWebApp(opts: WebOptions): Hono {
  const { registry, hub, logs, env } = opts;
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/static/htmx.min.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(HTMX);
  });

  // Plugin routes that must work without the UI password (images for Discord, webhooks).
  app.all('/public/:id/*', (c) => {
    const view = registry.get(c.req.param('id'));
    if (!view?.live) return c.text('Not found', 404);
    return view.live.publicApp.fetch(c.req.raw);
  });

  if (opts.uiPassword) {
    const password = opts.uiPassword;
    app.use('*', basicAuth({ verifyUser: (_user, pass) => pass === password, realm: 'server-rpc' }));
  }
  app.use('*', csrf());

  const origin = (c: Context) => env.publicUrl ?? new URL(c.req.url).origin;

  // ---- dashboard -------------------------------------------------------------------------------
  const Dashboard = () => {
    const views = registry.list();
    const sources = views.filter((v) => v.plugin?.kind === 'source');
    const outputs = views.filter((v) => v.plugin?.kind === 'output');
    return (
      <div hx-get="/partials/dashboard" hx-trigger="every 3s" hx-swap="outerHTML">
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
            <SettingsFields schema={plugin.configSchema} values={extra?.values ?? view.config.config} errors={extra?.errors} />
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
      const form = await c.req.parseBody();
      const raw = parseSettingsForm(view.plugin.configSchema, form, view.config.config);
      const result = await registry.saveConfig(view.config.id, raw, String(form.label ?? ''));
      if (!result.ok) return instancePage(c, view, { errors: issuesByField(result.issues), values: { ...view.config.config, ...raw } });
      return c.redirect(`/instances/${view.config.id}?notice=saved`);
    }),
  );
  app.post('/instances/:id/enable', withView(async (c, view) => {
    await registry.setEnabled(view.config.id, true);
    return c.redirect(`/instances/${view.config.id}`);
  }));
  app.post('/instances/:id/disable', withView(async (c, view) => {
    await registry.setEnabled(view.config.id, false);
    return c.redirect(`/instances/${view.config.id}`);
  }));
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
