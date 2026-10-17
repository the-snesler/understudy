import crypto from 'node:crypto';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { errorMessage } from '../../core/log.js';
import { defineOutput, type OutputContext, type PanelProps } from '../../core/plugin.js';
import { Layout, Notice, timeAgo } from '../../web/layout.js';
import { Icon } from '../../web/icons.js';
import { DiscordApi, type TokenProvider } from './api.js';
import { GatewayPresence } from './gateway-presence.js';
import { DiscordGateway, onlineCheck, realSessions, type GatewaySession } from './gateway.js';
import { HeadlessSession } from './headless.js';
import {
  buildAuthorizeUrl,
  createPkce,
  DEFAULT_ENDPOINTS,
  exchangeCode,
  OAuthError,
  parseCallbackInput,
  refreshTokens,
  revokeToken,
  type TokenSet,
} from './oauth.js';
import { Publisher, type PresenceGate, type PublishedState } from './publisher.js';
import { discordStatusWatched, notifyDiscordStatus, provideDiscordStatus } from './status-bus.js';

const WHEN = { title: 'When to show', description: 'Keep Discord in step with whether you’re actually on it.' };
const APPLICATION = { title: 'Discord application', description: 'The app in Discord’s Developer Portal that Understudy signs in through.' };
const configSchema = z.object({
  onlyWhenOnline: z.boolean().default(true).meta({
    title: 'Only while I’m on Discord', group: WHEN,
    description: 'Shows the activity only while one of your real clients (desktop, web or mobile) is on, with the same status. Understudy keeps one extra connection that stays invisible otherwise.',
  }),
  onlineStatuses: z.array(z.enum(['online', 'idle', 'dnd'])).default(['online', 'idle', 'dnd']).meta({
    title: 'Statuses that count as on', group: WHEN, widget: 'segmented',
    labels: { online: 'Online', idle: 'Idle', dnd: 'Do not disturb' },
    showIf: { field: 'onlyWhenOnline', equals: true },
  }),
  refreshMinutes: z.number().int().min(1).max(15).default(5).meta({
    title: 'Re-send every (minutes)', group: WHEN, disabledIf: { field: 'onlyWhenOnline', equals: true },
    description: 'Only used when “Only while I’m on Discord” is off. That mode makes you appear online, and the activity lingers for a few minutes after it ends.',
  }),
  applicationId: z.string().trim().regex(/^(\d{17,21})?$/, 'Must be a numeric Discord application ID').default('').meta({
    title: 'Application ID', group: APPLICATION,
    description: 'Developer Portal → your app → General Information.',
  }),
});

type Config = z.infer<typeof configSchema>;

interface StoredTokens extends TokenSet {
  clientId: string;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

interface PersistedState {
  tokens?: StoredTokens;
  user?: DiscordUser;
  sessionToken?: string;
  /** Our recent Gateway session ids, newest last. */
  gatewaySessions?: string[];
}

/** Refresh the access token when it has less than this left (tokens last 7 days). */
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

class NotConnectedError extends Error {}

function createDiscord(ctx: OutputContext<Config>) {
  const { config, log, state } = ctx;
  const endpoints = DEFAULT_ENDPOINTS;
  const read = (): PersistedState => (state.get() ?? {}) as PersistedState;
  const write = (patch: Partial<PersistedState>) => state.set({ ...read(), ...patch });

  // Tokens granted to a different application are useless (and so is its headless session).
  const stored = read();
  if (stored.tokens && stored.tokens.clientId !== config.applicationId) {
    log.info('Application ID changed; forgetting the previous Discord connection');
    state.set({}).catch((err: unknown) => log.error(`Could not save state: ${errorMessage(err)}`));
  }

  let refreshing: Promise<string> | undefined;
  let authError: string | undefined;
  const pending = new Map<string, { verifier: string; redirectUri: string; createdAt: number }>();

  const connected = () => !!config.applicationId && !!read().tokens;

  const tokens: TokenProvider = {
    async accessToken() {
      const t = read().tokens;
      if (!t) throw new NotConnectedError('Discord is not connected');
      if (t.expiresAt - Date.now() > REFRESH_MARGIN_MS) return t.accessToken;
      return this.forceRefresh();
    },
    forceRefresh() {
      refreshing ??= (async () => {
        const t = read().tokens;
        if (!t?.refreshToken) throw new NotConnectedError('Discord is not connected');
        try {
          const next = await refreshTokens({ endpoints, clientId: t.clientId, refreshToken: t.refreshToken });
          await write({ tokens: { ...next, clientId: t.clientId } });
          log.info('Refreshed the Discord access token');
          authError = undefined;
          return next.accessToken;
        } catch (err) {
          if (err instanceof OAuthError && err.status === 400) {
            // invalid_grant: the user revoked access or the refresh token is gone.
            authError = 'Discord rejected the refresh token; reconnect.';
            await write({ tokens: undefined, sessionToken: undefined });
          }
          throw err;
        } finally {
          refreshing = undefined;
        }
      })();
      return refreshing;
    },
  };

  const api = new DiscordApi({ apiBase: endpoints.apiBase, tokens, log });
  const headless = new HeadlessSession(
    api,
    { load: () => read().sessionToken, save: (sessionToken) => write({ sessionToken }) },
    log,
  );

  // "Only while you are on Discord": an invisible Gateway connection watches the user's sessions
  // and carries the activity itself. Otherwise, a headless session.
  const gateway = new DiscordGateway({
    token: () => tokens.accessToken(),
    refreshToken: () => tokens.forceRefresh(),
    log: log.child(`${ctx.instanceId}/gateway`),
    onChange: () => {
      publisher.kick();
      notifyDiscordStatus();
    },
    previousSessionIds: () => read().gatewaySessions ?? [],
    onSessionId: (id) => {
      const ids = [...(read().gatewaySessions ?? []).filter((x) => x !== id), id].slice(-10);
      write({ gatewaySessions: ids }).catch((err: unknown) => log.error(`Could not save state: ${errorMessage(err)}`));
    },
  });
  const session = config.onlyWhenOnline ? new GatewayPresence(gateway, api, config.applicationId, log) : headless;
  const gate: PresenceGate = {
    check() {
      if (!config.onlyWhenOnline) return { allowed: true };
      if (!gateway.informed) {
        const why = gateway.state === 'failed' ? `can't watch your status (${gateway.lastError})` : 'checking your Discord status';
        return { allowed: false, reason: why };
      }
      return onlineCheck(gateway.sessions, gateway.ownSessionIds, config.onlineStatuses);
    },
  };
  // The Gateway also feeds the Discord status history source; it stays invisible unless publishing.
  const syncGateway = () => {
    if ((config.onlyWhenOnline || discordStatusWatched()) && connected()) gateway.start();
    else if (gateway.state !== 'stopped') gateway.stop();
  };

  const publisher = new Publisher({ config, session, log, ready: connected, gate, reportShown: ctx.reportShown, reportSuccess: ctx.reportSuccess });

  function redirectUri(c: Context): string {
    const origin = ctx.env.publicUrl ?? new URL(c.req.url).origin;
    return `${origin}${ctx.routeBase}/callback`;
  }

  async function completeLogin(code: string, stateParam: string | undefined): Promise<void> {
    let entry = stateParam ? pending.get(stateParam) : undefined;
    // A pasted bare code has no state; fall back to the most recent login attempt.
    if (!entry && !stateParam) entry = [...pending.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!entry || Date.now() - entry.createdAt > PENDING_TTL_MS) {
      throw new Error('This login link has expired or did not start here. Click Connect again.');
    }
    if (stateParam) pending.delete(stateParam);
    const t = await exchangeCode({
      endpoints,
      clientId: config.applicationId,
      code,
      redirectUri: entry.redirectUri,
      verifier: entry.verifier,
    });
    if (!t.scope.split(' ').includes('sdk.social_layer_presence') && !t.scope.includes('activities.write')) {
      throw new Error(`Discord granted "${t.scope}", which can't set presence.`);
    }
    await write({ tokens: { ...t, clientId: config.applicationId }, sessionToken: undefined });
    authError = undefined;
    try {
      const me = await api.request<DiscordUser>('GET', '/users/@me');
      await write({ user: { id: me.body.id, username: me.body.username, global_name: me.body.global_name } });
      log.info(`Connected to Discord as ${me.body.username}`);
    } catch (err) {
      log.warn(`Connected, but could not look up the user: ${errorMessage(err)}`);
    }
    syncGateway();
    publisher.resume();
  }

  function errorPage(c: Context, message: string, back: string) {
    return c.html(
      <Layout title="Discord">
        <Notice kind="error">{message}</Notice>
        <a href={back}>Back</a>
      </Layout>,
      400,
    );
  }

  const pagePath = `/instances/${ctx.instanceId}`;
  let unprovide: (() => void) | undefined;

  return {
    start() {
      publisher.start();
      unprovide = provideDiscordStatus({
        instanceId: ctx.instanceId,
        sync: () => {
          if (!ctx.signal.aborted) syncGateway();
        },
        snapshot: () => ({
          connected: connected(),
          informed: gateway.informed,
          gatewayState: gateway.state,
          ...(gateway.lastError ? { lastError: gateway.lastError } : {}),
          applicationId: config.applicationId,
          sessions: realSessions(gateway.sessions, gateway.ownSessionIds),
        }),
      });
      syncGateway();
      // Switched from headless mode: withdraw what that left behind (as far as Discord allows).
      if (config.onlyWhenOnline && headless.active && connected()) {
        headless.clear().catch((err: unknown) => log.warn(`Could not delete the old headless session: ${errorMessage(err)}`));
      }
    },
    async stop() {
      try {
        await publisher.stop();
      } catch (err) {
        log.warn(`Could not withdraw the activity: ${errorMessage(err)}`);
      }
      gateway.stop();
      unprovide?.();
    },
    onState(s: Parameters<Publisher['onState']>[0]) {
      publisher.onState(s);
    },
    status() {
      if (!config.applicationId) return { health: 'setup' as const, message: 'Set the Application ID' };
      if (!read().tokens) return { health: 'setup' as const, message: authError ?? 'Not connected; click Connect' };
      if (publisher.lastError) return { health: 'error' as const, message: publisher.lastError };
      const pub = publisher.current();
      if (pub) return { health: 'ok' as const, message: `Showing ${pub.discord.name}: ${pub.discord.details ?? ''}` };
      if (publisher.gateReason) return { health: 'idle' as const, message: `Hidden: ${publisher.gateReason}` };
      return { health: 'idle' as const, message: 'Connected; nothing to show' };
    },

    routes(app: Hono) {
      app.get('/connect', (c) => {
        if (!config.applicationId) return errorPage(c, 'Set the Application ID first.', pagePath);
        const { verifier, challenge } = createPkce();
        const stateParam = crypto.randomBytes(16).toString('base64url');
        const uri = redirectUri(c);
        for (const [k, v] of pending) if (Date.now() - v.createdAt > PENDING_TTL_MS) pending.delete(k);
        pending.set(stateParam, { verifier, redirectUri: uri, createdAt: Date.now() });
        return c.redirect(
          buildAuthorizeUrl({ endpoints, clientId: config.applicationId, redirectUri: uri, state: stateParam, challenge }),
        );
      });

      app.get('/callback', async (c) => {
        const parsed = parseCallbackInput(c.req.url);
        if (parsed.error) return errorPage(c, `Discord returned an error: ${parsed.error}`, pagePath);
        if (!parsed.code) return errorPage(c, 'No code in this request.', pagePath);
        try {
          await completeLogin(parsed.code, parsed.state);
        } catch (err) {
          log.error(`Login failed: ${errorMessage(err)}`);
          return errorPage(c, errorMessage(err), pagePath);
        }
        return c.redirect(`${pagePath}?notice=connected`);
      });

      app.post('/paste', async (c) => {
        const form = await c.req.parseBody();
        const parsed = parseCallbackInput(String(form.url ?? ''));
        if (parsed.error) return errorPage(c, `Discord returned an error: ${parsed.error}`, pagePath);
        if (!parsed.code) return errorPage(c, 'Paste the full URL you were redirected to, or its code.', pagePath);
        try {
          await completeLogin(parsed.code, parsed.state);
        } catch (err) {
          log.error(`Login failed: ${errorMessage(err)}`);
          return errorPage(c, errorMessage(err), pagePath);
        }
        return c.redirect(`${pagePath}?notice=connected`);
      });

      app.post('/disconnect', async (c) => {
        try {
          await publisher.disconnect(async () => {
            await session.clear();
            if (headless.active) await headless.clear();
          });
        } catch (err) {
          log.warn(`Could not withdraw the activity: ${errorMessage(err)}`);
        }
        gateway.stop();
        const t = read().tokens;
        if (t) {
          await revokeToken({ endpoints, clientId: t.clientId, token: t.refreshToken ?? t.accessToken }).catch(
            (err: unknown) => log.warn(`Could not revoke the token: ${errorMessage(err)}`),
          );
        }
        await state.set({});
        syncGateway();
        publisher.kick();
        log.info('Disconnected from Discord');
        return c.redirect(`${pagePath}?notice=disconnected`);
      });

      app.post('/resend', (c) => {
        publisher.kick(true);
        return c.redirect(`${pagePath}?notice=resent`);
      });
    },

    formContext(props: PanelProps) {
      const redirect = `${ctx.env.publicUrl ?? props.origin}${ctx.routeBase}/callback`;
      const signedIn = !!read().tokens;
      // Portal switches cannot be inspected through OAuth; completion remains honest about that.
      return { notes: { applicationId: <details class="setup-checklist field-wide">
        <summary>Setup checklist <span class="small muted">{config.applicationId ? 'Application ID set' : 'Application ID needed'}{signedIn ? ' · signed in' : ''}</span></summary>
        <ol class="setup-steps">
          <li><a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Open your application in Discord’s Developer Portal</a> and copy its Application ID.</li>
          <li>In <strong>OAuth2</strong>, turn on <strong>Public Client</strong>. Add this redirect URL:<div class="copy-row"><code id="discord-redirect-url">{redirect}</code><button type="button" class="btn secondary small" data-copy={redirect}>Copy</button></div></li>
          <li>In <strong>Discord Social SDK → Getting Started</strong>, enable the Social SDK.</li>
          <li>Save the application settings, then connect your Discord account above.</li>
        </ol>
      </details> } };
    },

    panel() {
      const stored = read();
      return <section class="card flush">
        <div class="card-header"><div><h2>Account</h2><p class="muted small">The Discord login that carries your activity.</p></div></div>
        <div class="card-body">
          {stored.tokens ? <div class="account-row">
            <div class="account-avatar">{(stored.user?.global_name || stored.user?.username || 'D').slice(0, 1).toUpperCase()}</div>
            <div class="account-details"><strong>{stored.user?.global_name || stored.user?.username || 'Discord account'}</strong>{stored.user && <span class="muted"> @{stored.user.username}</span>}<div class="small muted">Token renews by itself · current one expires {new Date(stored.tokens.expiresAt).toLocaleString()}</div></div>
            <form method="post" action={`${ctx.routeBase}/disconnect`}><button class="btn danger">Disconnect</button></form>
          </div> : <>
            {authError && <Notice kind="error">{authError}</Notice>}
            <p class="muted">{config.applicationId ? 'Connect the account you want to show activity on.' : 'Set the Application ID and save, then connect your Discord account.'}</p>
            {config.applicationId && <>
              <a class="btn" href={`${ctx.routeBase}/connect`}>Connect Discord</a>
              <details class="login-fallback"><summary class="small">Redirect page didn’t load?</summary><p class="help">Copy the complete redirect URL from your browser and paste it here to finish signing in.</p><form method="post" action={`${ctx.routeBase}/paste`}><label class="field-label" for="discord-callback-url">Redirect URL</label><input id="discord-callback-url" type="text" name="url" placeholder="https://…/callback?code=…" /><button class="btn secondary">Finish login</button></form></details>
            </>}
          </>}
        </div>
      </section>;
    },

    live() {
      const pub = publisher.current();
      const candidate = publisher.candidate();
      return <>
        <section class="card flush">
          <div class="card-header"><h2>Now showing</h2>{pub && <span class="small muted">sent {timeAgo(pub.sentAt)}</span>}</div>
          <div class="card-body">
            {pub ? <ActivityPreview pub={pub} /> : <p class="muted">{publisher.gateReason ? `Hidden: ${publisher.gateReason}.` : candidate && !connected() ? `Will show “${candidate.activity.title}” once connected.` : 'No source is playing anything.'}</p>}
            {publisher.lastError && <Notice kind="error">Last error: {publisher.lastError}</Notice>}
          </div>
        </section>
        <section class="card flush">
          <div class="card-header"><h2>Connection</h2></div>
          <div class="card-body">{config.onlyWhenOnline && connected() ? <SessionsView gateway={gateway} /> : <dl class="detail-list"><dt>Discord account</dt><dd>{connected() ? 'Connected' : 'Not connected'}</dd><dt>Understudy’s session</dt><dd>{headless.active ? 'Online, with activity' : 'Inactive'}</dd><dt>Mode</dt><dd>{config.onlyWhenOnline ? 'Only while you’re on Discord' : 'Show even when Discord is closed'}</dd></dl>}</div>
        </section>
      </>;
    },
  };
}

function SessionsView({ gateway }: { gateway: DiscordGateway }) {
  const own = gateway.ownSessionIds;
  const real = realSessions(gateway.sessions, own);
  const role = (session: GatewaySession) => session.session_id === gateway.sessionId ? 'Understudy (Gateway)' : own.has(session.session_id) ? 'Understudy (previous)' : session.session_id.startsWith('h:') ? 'Understudy (headless)' : session.session_id === 'all' ? 'Combined' : 'Your client';
  const state = { connecting: 'Connecting', ready: 'Connected', reconnecting: 'Reconnecting', stopped: 'Stopped', failed: 'Failed' }[gateway.state];
  return <>
    <dl class="detail-list"><dt>Your clients</dt><dd>{gateway.informed ? real.length ? real.map((session) => `${session.status} · ${session.client_info?.client ?? 'client'}`).join(', ') : 'Offline' : 'Checking…'}</dd><dt>Understudy’s session</dt><dd>{gateway.presence ? `${gateway.presence.status}${gateway.presence.activities.length ? ', with activity' : ''}` : 'Inactive'}</dd><dt>Gateway</dt><dd>{state}</dd></dl>
    {gateway.lastError && gateway.state !== 'ready' && <p class="help field-error">{gateway.lastError}</p>}
    {!!gateway.sessions.length && <details class="session-details"><summary class="small">All connections</summary><div class="table-scroll"><table class="small"><tbody>{gateway.sessions.map((session) => <tr><td>{role(session)}</td><td>{[session.client_info?.client, session.client_info?.os].filter(Boolean).join(' / ')}</td><td>{session.status}</td></tr>)}</tbody></table></div></details>}
  </>;
}

function ActivityPreview({ pub }: { pub: PublishedState }) {
  const d = pub.discord;
  const verb = { 0: 'Playing', 2: 'Listening to', 3: 'Watching' }[d.type];
  return (
    <div>
      <div class="activity-preview">
        <div class="activity-art">{d.assets?.large_image ? <img src={d.assets.large_image} alt={d.assets.large_text ?? ''} /> : <Icon name={d.type === 2 ? 'music' : 'monitor'} size={28} />}</div>
        <div>
          <div class="small activity-kind">
            {verb} {d.name}
          </div>
          {d.details && <div><strong>{d.details}</strong></div>}
          {d.state && <div>{d.state}</div>}
          {d.timestamps?.end && (
            <div class="small muted">ends {new Date(Number(d.timestamps.end)).toLocaleTimeString()}</div>
          )}
        </div>
      </div>
      <p class="small muted">
        From <code>{pub.sourceId}</code>.
      </p>
      <details>
        <summary class="small">Payload</summary>
        <pre>{JSON.stringify(d, null, 2)}</pre>
      </details>
    </div>
  );
}

export const discordPlugin = defineOutput({
  id: 'discord',
  name: 'Discord',
  description: 'Shows the Hub’s selected activity as your Discord presence.',
  configSchema,
  create: createDiscord,
});
