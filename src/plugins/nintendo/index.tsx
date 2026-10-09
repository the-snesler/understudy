import type { Hono } from 'hono';
import type { CoralAuthData } from 'nxapi/coral';
import { z } from 'zod';
import type { NowPlaying } from '../../core/activity.js';
import { errorMessage } from '../../core/log.js';
import { defineSource, type SourceContext } from '../../core/plugin.js';
import { Notice, timeAgo } from '../../web/layout.js';
import {
  NintendoAuthError,
  NxapiBackend,
  userAgent,
  type CoralConnection,
  type FriendInfo,
  type NintendoBackend,
  type PendingLogin,
} from './client.js';
import { consoleName, presenceKey, toNowPlaying } from './presence.js';

const ZNCA_API_URL = 'https://github.com/samuelthomas2774/nxapi-znca-api';
const END_USER_HELP_URL = 'https://github.com/samuelthomas2774/nxapi-znca-api/blob/docs/docs/end-user-help.md';
const NXAPI_AUTH_URL = 'https://nxapi-auth.fancy.org.uk/oauth/clients';

const configSchema = z.object({
  clientId: z
    .string()
    .trim()
    .default(process.env.NXAPI_AUTH_CLIENT_ID ?? '')
    .meta({
      title: 'nxapi-auth client ID',
      description: 'The Client ID of the public client you registered on nxapi-auth (see the steps above). It identifies this app to the f-token API; it is not a secret.',
    }),
  pollSeconds: z
    .number()
    .int()
    .min(30)
    .max(600)
    .default(60)
    .meta({ title: 'Poll interval (seconds)', description: "How often to check your friend's presence. nxapi's own monitor uses 60." }),
  activityName: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Activity name', description: 'Leave empty for "Nintendo Switch" or "Nintendo Switch 2", depending on the console.' }),
  titleTemplate: z
    .string()
    .default('{game}')
    .meta({
      title: 'First line',
      description:
        'Variables: {game} {description} (the game\'s own status text, if any) {console} {playTime} {online} ("Playing online" when online) {name}. Text in [brackets] is dropped if a variable inside is empty.',
    }),
  subtitleTemplate: z.string().default('[{description}]').meta({ title: 'Second line', description: '' }),
  smallImage: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Small image', description: 'Badge in the corner of the game art: a square HTTPS image URL or a Discord app asset key.' }),
  eshopButton: z.boolean().default(false).meta({ title: 'Nintendo eShop button', description: "Add a button linking to the game's eShop page." }),
});

type Config = z.infer<typeof configSchema>;

interface PersistedState {
  /** When the user acknowledged the third-party API notice. */
  consentAt?: number;
  pending?: PendingLogin;
  sessionToken?: string;
  auth?: CoralAuthData;
  /** Nintendo Switch Online name of the signed-in (secondary) account. */
  account?: string;
  /** The friend whose presence we show (normally the user's main account). */
  friend?: { nsaId: string; name: string };
}

const MAX_FAILURES = 3;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 30 * 60 * 1000;

export function createNintendoPlugin(makeBackend: (cfg: Config, dataDir?: string) => NintendoBackend) {
  function createNintendo(ctx: SourceContext<Config>) {
    const { config, log } = ctx;
    const read = (): PersistedState => (ctx.state.get() ?? {}) as PersistedState;
    const write = (patch: Partial<PersistedState>) => ctx.state.set({ ...read(), ...patch });
    const backend = makeBackend(config, ctx.env.dataDir);

    let connection: CoralConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let friends: FriendInfo[] | undefined;
    let friendsAt = 0;
    let lastError: string | undefined;
    let failures = 0;
    let busy: string | undefined;
    /** When the current game was first seen, so the elapsed timer stays put between polls. */
    let started: { key: string; at: number } | undefined;
    let published: NowPlaying | null = null;

    const signedIn = () => !!(read().sessionToken && read().auth);

    function connect(): CoralConnection | undefined {
      const s = read();
      if (!config.clientId || !s.consentAt || !s.sessionToken || !s.auth) return undefined;
      connection ??= backend.connect(s.sessionToken, s.auth, (auth) => {
        write({ auth }).catch((err: unknown) => log.error(`Could not save state: ${errorMessage(err)}`));
        log.info('Renewed the Nintendo Switch Online token');
      });
      return connection;
    }

    async function signOut(reason?: string): Promise<void> {
      clearTimeout(timer);
      connection = undefined;
      friends = undefined;
      published = null;
      ctx.publish(null);
      await write({ sessionToken: undefined, auth: undefined, account: undefined, pending: undefined });
      if (reason) lastError = reason;
    }

    async function refreshFriends(): Promise<FriendInfo[]> {
      const conn = connect();
      if (!conn) throw new Error('Not signed in');
      friends = await conn.friends();
      friendsAt = Date.now();
      return friends;
    }

    function publishFrom(list: FriendInfo[]): void {
      const target = read().friend;
      const f = target && list.find((x) => x.nsaId === target.nsaId);
      if (!f) {
        published = null;
        ctx.publish(null);
        return;
      }
      const key = presenceKey(f);
      if (!key) started = undefined;
      else if (started?.key !== key) {
        // Nintendo's updatedAt is the best guess for a game that was already running when we
        // started watching; otherwise the game started about now.
        const updated = f.presence.updatedAt * 1000;
        started = { key, at: !published && updated < Date.now() && Date.now() - updated < 6 * 3600_000 ? updated : Date.now() };
      }
      published = toNowPlaying(f, config, started?.at ?? Date.now());
      ctx.publish(published);
    }

    async function poll(): Promise<void> {
      if (ctx.signal.aborted || !read().friend) return;
      let delay = config.pollSeconds * 1000;
      try {
        publishFrom(await refreshFriends());
        if (lastError) log.info('Nintendo Switch Online is reachable again');
        lastError = undefined;
        failures = 0;
      } catch (err) {
        if (err instanceof NintendoAuthError && err.signInAgain) {
          log.error(err.message);
          await signOut(err.message);
          return;
        }
        const msg = errorMessage(err);
        if (msg !== lastError) log.error(`Could not fetch friends: ${msg}`);
        lastError = msg;
        if (++failures >= MAX_FAILURES) {
          published = null;
          ctx.publish(null);
        }
        // Back off instead of retrying (nxapi-znca-api's terms forbid automatic retries).
        delay = Math.min(delay * 2 ** failures, MAX_BACKOFF_MS);
      }
      if (!ctx.signal.aborted) timer = setTimeout(() => void poll(), delay);
    }

    function restartPolling(): void {
      clearTimeout(timer);
      failures = 0;
      if (connect() && read().friend) void poll();
    }

    const back = `/instances/${ctx.instanceId}`;
    const fail = (msg: string) => `${back}?error=${encodeURIComponent(msg)}`;

    return {
      start() {
        restartPolling();
      },
      stop() {
        clearTimeout(timer);
      },
      status() {
        const s = read();
        if (!config.clientId) return { health: 'setup' as const, message: 'Set the nxapi-auth client ID' };
        if (!s.consentAt) return { health: 'setup' as const, message: 'Read and accept the notice to sign in' };
        if (!signedIn()) return { health: lastError ? ('error' as const) : ('setup' as const), message: lastError ?? 'Sign in with your secondary Nintendo Account' };
        if (!s.friend) return { health: 'setup' as const, message: 'Choose the friend to show' };
        if (lastError) return { health: 'error' as const, message: lastError };
        if (published) return { health: 'ok' as const, message: `${s.friend.name} is playing ${published.title}` };
        return { health: 'idle' as const, message: `${s.friend.name} isn't playing anything` };
      },

      routes(app: Hono) {
        app.post('/consent', async (c) => {
          const form = await c.req.parseBody();
          if (form.ack !== 'on') return c.redirect(fail('Tick the box to confirm you have read the notice.'));
          await write({ consentAt: Date.now() });
          log.info('Third-party API notice accepted');
          return c.redirect(back);
        });

        app.post('/login', async (c) => {
          if (!config.clientId) return c.redirect(fail('Set the nxapi-auth client ID first.'));
          if (!read().consentAt) return c.redirect(fail('Accept the notice first.'));
          try {
            busy = 'Preparing sign-in…';
            await write({ pending: await backend.beginLogin() });
          } catch (err) {
            return c.redirect(fail(`Could not start sign-in: ${errorMessage(err)}`));
          } finally {
            busy = undefined;
          }
          return c.redirect(back);
        });

        app.post('/login/finish', async (c) => {
          const pending = read().pending;
          if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
            return c.redirect(fail('That sign-in link has expired. Get a new one.'));
          }
          const form = await c.req.parseBody();
          try {
            busy = 'Signing in…';
            const result = await backend.completeLogin(pending, String(form.link ?? ''));
            await write({ sessionToken: result.sessionToken, auth: result.auth, account: result.accountName, pending: undefined });
            connection = undefined;
            lastError = undefined;
            log.info(`Signed in to Nintendo Switch Online as ${result.accountName}`);
            await refreshFriends().catch((err: unknown) => log.warn(`Could not fetch friends: ${errorMessage(err)}`));
            restartPolling();
          } catch (err) {
            return c.redirect(fail(`Sign-in failed: ${errorMessage(err)}`));
          } finally {
            busy = undefined;
          }
          return c.redirect(`${back}?message=${encodeURIComponent('Signed in. Now choose the friend to show.')}`);
        });

        app.post('/friends/refresh', async (c) => {
          try {
            await refreshFriends();
          } catch (err) {
            return c.redirect(fail(`Could not fetch friends: ${errorMessage(err)}`));
          }
          return c.redirect(back);
        });

        app.post('/friend', async (c) => {
          const form = await c.req.parseBody();
          const f = friends?.find((x) => x.nsaId === String(form.nsaId ?? ''));
          if (!f) return c.redirect(fail('Pick a friend from the list.'));
          await write({ friend: { nsaId: f.nsaId, name: f.name } });
          started = undefined;
          log.info(`Showing ${f.name}'s presence`);
          publishFrom(friends!);
          restartPolling();
          return c.redirect(back);
        });

        app.post('/signout', async (c) => {
          await signOut();
          log.info('Signed out of Nintendo Switch Online');
          return c.redirect(`${back}?message=${encodeURIComponent('Signed out; the session token was deleted.')}`);
        });
      },

      panel() {
        const s = read();
        if (!config.clientId) {
          return (
            <div class="card">
              <h2>Register this app with nxapi-auth</h2>
              <p>
                Signing in to Nintendo Switch Online depends on nxapi's f-token API, which needs to know which app is calling it. Register
                this app once:
              </p>
              <ol>
                <li>
                  Go to <a href={NXAPI_AUTH_URL}>nxapi-auth</a>, sign in, and register a new OAuth client. Name it anything (e.g.
                  "Understudy") and choose <strong>Public</strong> as the type.
                </li>
                <li>
                  Under <strong>Allowed grant types</strong>, tick <strong>Client credentials</strong> and <strong>Refresh token</strong>.
                  Fill in a description and a contact URL, then save.
                </li>
                <li>
                  Under <strong>Scope</strong>, in the <strong>nxapi-znca-api</strong> section, tick only <strong>f-generation</strong>,{' '}
                  <strong>Request encryption</strong> and <strong>Response decryption</strong>, then save. Leave every other scope,
                  and the client authentication section, alone.
                </li>
                <li>
                  Copy the <strong>Client ID</strong> from the top of the client's page into <strong>nxapi-auth client ID</strong> below,
                  and save.
                </li>
              </ol>
            </div>
          );
        }
        if (!s.consentAt) {
          return (
            <form class="card" method="post" action={`${ctx.routeBase}/consent`}>
              <h2>Before you sign in</h2>
              <p>
                Nintendo's API only accepts sign-ins from its own app, which proves itself with a token generated inside that app. This
                server gets that token from a third-party service, <a href={ZNCA_API_URL}>nxapi-znca-api</a>, using{' '}
                <a href="https://github.com/samuelthomas2774/nxapi">nxapi</a>.
              </p>
              <p>
                <strong>
                  Your Nintendo Account id_token, your Nintendo Switch Online (Coral) token, and data sent to and received from Nintendo's
                  Coral API will be sent to nxapi-znca-api.
                </strong>{' '}
                nxapi also downloads its configuration from fancy.org.uk. See <a href={END_USER_HELP_URL}>what this means</a>.
              </p>
              <p>
                Sign in with a <strong>secondary Nintendo Account</strong> that is friends with your main one, not your main account. Your
                main account's presence is read from the secondary account's friend list, so a problem with the secondary account can't
                affect your main one.
              </p>
              <label>
                <input type="checkbox" name="ack" required />I understand, and agree to this data being sent to nxapi-znca-api.
              </label>
              <div class="actions">
                <button>Continue</button>
              </div>
            </form>
          );
        }
        if (!signedIn()) {
          return (
            <div class="card">
              <h2>Sign in with your secondary Nintendo Account</h2>
              {!s.pending || Date.now() - s.pending.createdAt > PENDING_TTL_MS ? (
                <form method="post" action={`${ctx.routeBase}/login`}>
                  <p>Make sure it's friends with your main account, and that your main account shares its online status with friends.</p>
                  <button>Get sign-in link</button>
                </form>
              ) : (
                <form method="post" action={`${ctx.routeBase}/login/finish`}>
                  <ol>
                    <li>
                      <a href={s.pending.url} target="_blank" rel="noreferrer">
                        Open the Nintendo sign-in page
                      </a>{' '}
                      and sign in with the <strong>secondary</strong> account.
                    </li>
                    <li>
                      On "Linking an External Account", right-click <strong>Select this person</strong> and copy the link. It starts with{' '}
                      <code>npf71b963c1b7b6d119://auth</code>.
                    </li>
                    <li>Paste it here:</li>
                  </ol>
                  <input type="text" name="link" placeholder="npf71b963c1b7b6d119://auth#session_token_code=…" required />
                  <div class="actions">
                    <button>Sign in</button>
                    <span class="muted small">Signing in contacts nxapi-znca-api and can take a few seconds.</span>
                  </div>
                </form>
              )}
            </div>
          );
        }
        return (
          <div class="card">
            <h2>Signed in as {s.account}</h2>
            {friends ? (
              <form method="post" action={`${ctx.routeBase}/friend`}>
                <p>Whose presence should be shown? Normally your main account.</p>
                <table>
                  <tbody>
                    {friends.map((f) => (
                      <tr>
                        <td>
                          <label style="margin: 0; font-weight: 400">
                            <input type="radio" name="nsaId" value={f.nsaId} checked={s.friend?.nsaId === f.nsaId} required />
                            {f.name}
                          </label>
                        </td>
                        <td class="small muted">{describePresence(f)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!friends.length && <p class="muted">This account has no friends yet. Add your main account as a friend on a Switch.</p>}
                <div class="actions">
                  <button>Use this friend</button>
                </div>
              </form>
            ) : (
              <p class="muted">{s.friend ? `Showing ${s.friend.name}.` : 'Load the friend list to choose whose presence to show.'}</p>
            )}
            <div class="actions">
              <form class="inline" method="post" action={`${ctx.routeBase}/friends/refresh`}>
                <button class="secondary">{friends ? 'Refresh friend list' : 'Load friend list'}</button>
              </form>
              <form class="inline" method="post" action={`${ctx.routeBase}/signout`}>
                <button class="danger">Sign out</button>
              </form>
            </div>
          </div>
        );
      },

      live() {
        const s = read();
        const f = s.friend && friends?.find((x) => x.nsaId === s.friend!.nsaId);
        if (!busy && !f) return null;
        return (
          <div class="card">
            {busy && <Notice>{busy}</Notice>}
            {f && (
              <>
                <h2>{f.name}</h2>
                <div class="preview">
                  {f.presence.game?.imageUri && <img src={f.presence.game.imageUri} alt="" />}
                  <div>
                    <div>{describePresence(f)}</div>
                    {published && (
                      <div class="small muted">
                        Published: {published.name} · {published.title}
                        {published.subtitle ? ` · ${published.subtitle}` : ''}
                      </div>
                    )}
                    <div class="small muted">Checked {timeAgo(friendsAt)}.</div>
                  </div>
                </div>
              </>
            )}
          </div>
        );
      },
    };
  }

  return defineSource({
    id: 'nintendo',
    name: 'Nintendo Switch',
    description: "What your main account is playing, read from a secondary account's friend list via nxapi.",
    configSchema,
    create: createNintendo,
  });
}

function describePresence(f: FriendInfo): string {
  const { state, game, platform } = f.presence;
  if ((state === 'ONLINE' || state === 'PLAYING') && game) return `Playing ${game.name} on ${consoleName(platform)}${state === 'PLAYING' ? ' (online)' : ''}`;
  if (state === 'INACTIVE') return 'Console online, not in a game';
  return 'Offline';
}

export const nintendoPlugin = createNintendoPlugin(
  (cfg, dataDir) => new NxapiBackend({ clientId: cfg.clientId, userAgent: userAgent(), dataDir }),
);
