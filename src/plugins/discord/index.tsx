import crypto from 'node:crypto';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { errorMessage } from '../../core/log.js';
import { defaultTimeZone, inWindows, isValidTimeZone, minutesInZone, parseWindows } from '../../core/schedule.js';
import { defineOutput, type OutputContext, type PanelProps } from '../../core/plugin.js';
import { Layout, Notice, timeAgo } from '../../web/layout.js';
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

const configSchema = z.object({
  applicationId: z
    .string()
    .trim()
    .regex(/^(\d{17,21})?$/, 'Must be a numeric Discord application ID')
    .default('')
    .meta({
      title: 'Application ID',
      description:
        'Developer Portal → your app → General Information. The app needs Public Client turned on (OAuth2 page) and the Social SDK enabled (Discord Social SDK → Getting Started).',
    }),
  sourcePriority: z
    .array(z.string().trim().min(1))
    .default([])
    .meta({
      title: 'Source priority',
      description:
        'Source instance ids, one per line, highest priority first. Discord shows one activity at a time; unlisted sources rank after these, and ties go to the most recent.',
    }),
  paused: z
    .enum(['hide', 'last', 'show'])
    .default('hide')
    .meta({
      title: 'Paused activities',
      description:
        '"hide" = clear your status while paused, like Spotify does. "last" = show paused activities only when nothing is playing. "show" = treat them like playing ones.',
    }),
  statusDisplay: z
    .enum(['details', 'name', 'state'])
    .default('details')
    .meta({
      title: 'Short status shows',
      description:
        'What the member list and DM list show: "details" = the title (e.g. "Watching The Matrix"), "name" = the app name ("Watching Plex"), "state" = the second line.',
    }),
  refreshMinutes: z
    .number()
    .int()
    .min(1)
    .max(15)
    .default(5)
    .meta({
      title: 'Refresh interval (minutes)',
      description:
        'Headless mode only (when "Only while you are on Discord" is off): how often the activity is re-sent. Headless sessions expire after ~20 minutes, and an activity hidden while you were Invisible only reappears on the next send.',
    }),
  onlyWhenOnline: z
    .boolean()
    .default(true)
    .meta({
      title: 'Only while you are on Discord',
      description:
        'Show the activity only while one of your real Discord clients (desktop, web or mobile) is online, with the same status. It is carried by an extra Discord connection that stays invisible otherwise. Turn off to show it even when Discord is closed: that uses a headless session, which makes you appear online and lingers for a few minutes after it is removed.',
    }),
  onlineStatuses: z
    .array(z.enum(['online', 'idle', 'dnd']))
    .default(['online', 'idle', 'dnd'])
    .meta({ title: 'Statuses that count as on Discord', description: 'Which statuses of your real clients allow the activity to show.' }),
  quietHours: z
    .string()
    .trim()
    .default('')
    .refine((v) => {
      try {
        parseWindows(v);
        return true;
      } catch {
        return false;
      }
    }, 'Use time ranges like 23:00-07:00, separated by commas')
    .meta({
      title: 'Quiet hours',
      description: 'Daily times when nothing is shown, e.g. "23:00-07:00" or "09:00-17:00, 22:00-08:00". Leave empty for none.',
    }),
  timeZone: z
    .string()
    .trim()
    .default(defaultTimeZone())
    .refine(isValidTimeZone, 'Not a known time zone (use a name like America/Chicago)')
    .meta({ title: 'Time zone for quiet hours', description: 'An IANA time zone name, e.g. America/Chicago. Defaults to the TZ variable or the server\'s zone.' }),
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
    onChange: () => publisher.kick(),
    previousSessionIds: () => read().gatewaySessions ?? [],
    onSessionId: (id) => {
      const ids = [...(read().gatewaySessions ?? []).filter((x) => x !== id), id].slice(-10);
      write({ gatewaySessions: ids }).catch((err: unknown) => log.error(`Could not save state: ${errorMessage(err)}`));
    },
  });
  const session = config.onlyWhenOnline ? new GatewayPresence(gateway, api, config.applicationId, log) : headless;
  const quietWindows = parseWindows(config.quietHours);
  const isQuiet = () => quietWindows.length > 0 && inWindows(quietWindows, minutesInZone(new Date(), config.timeZone));
  let quietTimer: ReturnType<typeof setInterval> | undefined;
  const gate: PresenceGate = {
    check() {
      if (isQuiet()) return { allowed: false, reason: `quiet hours (${config.quietHours})` };
      if (!config.onlyWhenOnline) return { allowed: true };
      if (!gateway.informed) {
        const why = gateway.state === 'failed' ? `can't watch your status (${gateway.lastError})` : 'checking your Discord status';
        return { allowed: false, reason: why };
      }
      return onlineCheck(gateway.sessions, gateway.ownSessionIds, config.onlineStatuses);
    },
  };
  const syncGateway = () => {
    if (config.onlyWhenOnline && connected()) gateway.start();
    else if (gateway.state !== 'stopped') gateway.stop();
  };

  const publisher = new Publisher({ config, session, log, sources: ctx.sources, ready: connected, gate });

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
    publisher.kick(true);
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

  return {
    start() {
      publisher.start();
      syncGateway();
      if (quietWindows.length) {
        // Re-check when quiet hours begin or end.
        let quiet = isQuiet();
        quietTimer = setInterval(() => {
          if (isQuiet() !== quiet) {
            quiet = !quiet;
            publisher.kick();
          }
        }, 30_000);
      }
      // Switched from headless mode: withdraw what that left behind (as far as Discord allows).
      if (config.onlyWhenOnline && headless.active && connected()) {
        headless.clear().catch((err: unknown) => log.warn(`Could not delete the old headless session: ${errorMessage(err)}`));
      }
    },
    async stop() {
      clearInterval(quietTimer);
      try {
        await publisher.stop();
      } catch (err) {
        log.warn(`Could not withdraw the activity: ${errorMessage(err)}`);
      }
      gateway.stop();
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
          await session.clear();
          if (headless.active) await headless.clear();
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

    panel(props: PanelProps) {
      const s = read();
      const origin = ctx.env.publicUrl ?? props.origin;
      return (
        <div class="card">
          <h2>Discord connection</h2>
          {!config.applicationId ? (
            <p>Set the Application ID below and save, then connect.</p>
          ) : s.tokens ? (
            <>
              <p>
                Connected{s.user ? <> as <strong>{s.user.global_name || s.user.username}</strong> (@{s.user.username})</> : ''}.{' '}
                <span class="muted small">Token renews automatically (current one expires {new Date(s.tokens.expiresAt).toLocaleString()}).</span>
              </p>
              <div class="actions">
                <form class="inline" method="post" action={`${ctx.routeBase}/resend`}>
                  <button class="secondary">Re-send now</button>
                </form>
                <form class="inline" method="post" action={`${ctx.routeBase}/disconnect`}>
                  <button class="danger">Disconnect</button>
                </form>
              </div>
            </>
          ) : (
            <>
              {authError && <Notice kind="error">{authError}</Notice>}
              <p>
                In the Developer Portal, add this under <strong>OAuth2 → Redirects</strong>:
                <br />
                <code>{`${origin}${ctx.routeBase}/callback`}</code>
              </p>
              <div class="actions">
                <a class="button" href={`${ctx.routeBase}/connect`}>
                  Connect Discord
                </a>
              </div>
              <form method="post" action={`${ctx.routeBase}/paste`}>
                <label>
                  Redirect page didn't load?
                  <div class="help">
                    That's fine if this server isn't reachable at the address above from your browser. Copy the full URL from the address
                    bar and paste it here.
                  </div>
                  <input type="text" name="url" placeholder={`${origin}${ctx.routeBase}/callback?code=…`} />
                </label>
                <div class="actions">
                  <button class="secondary">Finish login</button>
                </div>
              </form>
            </>
          )}
        </div>
      );
    },

    live() {
      const pub = publisher.current();
      const cand = publisher.candidate();
      return (
        <div class="card">
          <h2>Now showing</h2>
          {pub ? (
            <ActivityPreview pub={pub} />
          ) : (
            <p class="muted">
              Nothing.{' '}
              {publisher.gateReason
                ? `Hidden: ${publisher.gateReason}.`
                : cand && !connected()
                  ? `Would show "${cand.activity.title}" from ${cand.sourceId} once connected.`
                  : 'No source is playing anything.'}
            </p>
          )}
          {publisher.lastError && <Notice kind="error">Last error: {publisher.lastError}</Notice>}
          {config.onlyWhenOnline && connected() && <SessionsView gateway={gateway} />}
        </div>
      );
    },
  };
}

function SessionsView({ gateway }: { gateway: DiscordGateway }) {
  const own = gateway.ownSessionIds;
  const real = realSessions(gateway.sessions, own);
  const role = (s: GatewaySession) =>
    s.session_id === gateway.sessionId
      ? 'this app (Gateway)'
      : own.has(s.session_id)
        ? 'this app (earlier connection)'
        : s.session_id.startsWith('h:')
          ? 'this app (headless)'
          : s.session_id === 'all'
            ? 'combined'
            : 'client';
  const label = { connecting: 'connecting', ready: 'connected', reconnecting: 'reconnecting', stopped: 'stopped', failed: 'failed' }[gateway.state];
  return (
    <details style="margin-top: .75rem">
      <summary class="small">
        Your Discord clients: {gateway.informed ? (real.length ? real.map((s) => s.status).join(', ') : 'none') : 'unknown'} · Gateway {label}
        {gateway.presence && ` · ours: ${gateway.presence.status}${gateway.presence.activities.length ? ' with activity' : ''}`}
      </summary>
      {gateway.lastError && gateway.state !== 'ready' && <p class="small muted">{gateway.lastError}</p>}
      {gateway.sessions.length > 0 && (
        <table class="small">
          <tbody>
            {gateway.sessions.map((s) => (
              <tr>
                <td>{role(s)}</td>
                <td>{[s.client_info?.client, s.client_info?.os].filter(Boolean).join(' / ')}</td>
                <td>{s.status}</td>
                <td class="muted">{(s.activities ?? []).map((a) => a.name).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

function ActivityPreview({ pub }: { pub: PublishedState }) {
  const d = pub.discord;
  const verb = { 0: 'Playing', 2: 'Listening to', 3: 'Watching' }[d.type];
  return (
    <div>
      <div class="preview">
        {d.assets?.large_image && <img src={d.assets.large_image} alt={d.assets.large_text ?? ''} />}
        <div>
          <div class="small muted">
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
        From <code>{pub.sourceId}</code>, last sent {timeAgo(pub.sentAt)}.
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
  description: 'Shows the highest-priority activity as your Discord presence, via a headless session.',
  configSchema,
  create: createDiscord,
});
