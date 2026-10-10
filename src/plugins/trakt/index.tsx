import type { Hono } from 'hono';
import { z } from 'zod';
import type { NowPlaying } from '../../core/activity.js';
import { errorMessage } from '../../core/log.js';
import { defineSource, type SourceContext } from '../../core/plugin.js';
import { Notice, timeAgo } from '../../web/layout.js';
import { ArtworkResolver, type Artwork } from './artwork.js';
import { TraktAuthError, TraktClient, TraktError, type DeviceCode, type TokenSet, type TraktWatching } from './client.js';
import { imageText, itemLinks, toNowPlaying } from './watching.js';

const NEW_APP_URL = 'https://app.trakt.tv/settings/apps/api/new';

const template = (title: string, value: string, description: string) =>
  z.string().default(value).meta({ title, description });

const VARS_HELP =
  'Variables: {title} {year} {show} {season} {episode} {seasonPadded} {episodePadded} {episodeTitle}. For episodes, {title} is the episode title and {year} the show\'s year. Text in [brackets] is dropped if a variable inside is empty.';

const configSchema = z.object({
  clientId: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Client ID', description: 'From the Trakt API app you created (see above). It identifies this app to Trakt.' }),
  clientSecret: z
    .string()
    .trim()
    .default('')
    .meta({
      title: 'Client secret (optional)',
      description: 'Trakt has deprecated it and connecting normally works without it. Set it only if Trakt rejects the connection.',
      secret: true,
    }),
  username: z
    .string()
    .trim()
    .regex(/^[^\s/]*$/, 'Just the username, e.g. "sean" from trakt.tv/users/sean')
    .default('')
    .meta({
      title: 'Trakt username',
      description: 'Whose activity to show: the name in your profile URL (trakt.tv/users/<name>). Leave empty to use the connected account.',
    }),
  pollSeconds: z
    .number()
    .int()
    .min(15)
    .max(300)
    .default(30)
    .meta({ title: 'Poll interval (seconds)', description: 'How often to ask Trakt what you are watching.' }),
  activityName: z.string().trim().min(1).default('Trakt').meta({ title: 'Activity name', description: 'Shown as "Watching <name>".' }),
  movieTitle: template('Movie: first line', '{title}[ ({year})]', VARS_HELP),
  movieSubtitle: template('Movie: second line', '', ''),
  episodeTitle: template('Episode: first line', '{show}', ''),
  episodeSubtitle: template('Episode: second line', 'S{seasonPadded}E{episodePadded}[ · {episodeTitle}]', ''),
  tmdbKey: z
    .string()
    .trim()
    .default('')
    .meta({
      title: 'TMDB API key (optional)',
      description: 'A TMDB v3 API key or v4 read access token, for movie and show posters (themoviedb.org → Settings → API).',
      secret: true,
    }),
  fallbackImage: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Fallback image', description: 'HTTPS URL or Discord app asset key used when no poster is found.' }),
  smallImage: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Small image', description: 'Badge in the corner of the poster: a square HTTPS image URL or a Discord app asset key (e.g. "trakt").' }),
  buttons: z
    .enum(['both', 'imdb', 'trakt', 'none'])
    .default('both')
    .meta({
      title: 'Buttons',
      description: '"both" = IMDb (or TMDB) and the Trakt page, "imdb" = IMDb, or TMDB if there is no IMDb id, "trakt" = the Trakt page, "none" = no buttons.',
    }),
});

type Config = z.infer<typeof configSchema>;

interface PersistedState {
  tokens?: TokenSet;
  /** Username of the connected account. */
  account?: string;
  /** A device code waiting to be entered on Trakt. */
  pending?: DeviceCode;
}

interface PollResult {
  at: number;
  user: string;
  watching: TraktWatching | null;
  activity?: NowPlaying;
  artwork?: Artwork;
}

/** Give up showing the last activity after this many failed polls in a row. */
const MAX_FAILURES = 3;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
/** Renew the access token once this share of its lifetime has passed. */
const REFRESH_AT = 0.75;

export function createTraktPlugin(fetchImpl?: typeof fetch) {
  function createTrakt(ctx: SourceContext<Config>) {
    const { config, log } = ctx;
    const read = (): PersistedState => (ctx.state.get() ?? {}) as PersistedState;
    const write = (patch: Partial<PersistedState>) => ctx.state.set({ ...read(), ...patch });
    /** Update the state now and persist it in the background (the store applies changes in memory at once). */
    const save = (patch: Partial<PersistedState>) => void write(patch).catch((err: unknown) => log.error(`Could not save state: ${errorMessage(err)}`));
    const client = new TraktClient({ clientId: config.clientId, clientSecret: config.clientSecret || undefined, fetchImpl });
    const resolver = new ArtworkResolver({ log, tmdbKey: config.tmdbKey || undefined, fallback: config.fallbackImage || undefined, fetchImpl });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let deviceTimer: ReturnType<typeof setTimeout> | undefined;
    /** Bumped on every restart of the poll loop, so a poll in flight doesn't schedule a second loop. */
    let generation = 0;
    let last: PollResult | undefined;
    let lastError: string | undefined;
    /** Connecting failed or the connection was dropped; shown on the panel. */
    let authError: string | undefined;
    let refreshError: string | undefined;
    let failures = 0;
    let refreshing: Promise<TokenSet> | undefined;
    let deviceDelay = 5_000;

    /** Whose activity to poll: the configured username, or the connected account. */
    const target = () => config.username || (read().tokens ? 'me' : undefined);
    const pendingCode = () => {
      const p = read().pending;
      return p && p.expiresAt > Date.now() ? p : undefined;
    };

    /** One refresh at a time: Trakt's refresh tokens are single-use. */
    function refresh(): Promise<TokenSet> {
      refreshing ??= (async () => {
        const current = read().tokens;
        if (!current) throw new TraktError('Not connected to Trakt');
        const tokens = await client.refresh(current.refreshToken);
        save({ tokens });
        log.info('Renewed the Trakt access token');
        refreshError = undefined;
        return tokens;
      })().finally(() => (refreshing = undefined));
      return refreshing;
    }

    /** The access token to send, renewed once most of its lifetime has passed. */
    async function accessToken(): Promise<string | undefined> {
      const t = read().tokens;
      if (!t) return undefined;
      if (Date.now() < t.createdAt + (t.expiresAt - t.createdAt) * REFRESH_AT) return t.accessToken;
      try {
        return (await refresh()).accessToken;
      } catch (err) {
        if (err instanceof TraktAuthError || Date.now() >= t.expiresAt) throw err;
        // Still valid for a while: keep using it and try again next poll.
        const msg = errorMessage(err);
        if (msg !== refreshError) log.warn(`Could not renew the Trakt access token yet: ${msg}`);
        refreshError = msg;
        return t.accessToken;
      }
    }

    function disconnect(reason?: string): TokenSet | undefined {
      const { tokens } = read();
      save({ tokens: undefined, account: undefined });
      authError = reason;
      return tokens;
    }

    async function poll(): Promise<void> {
      const user = target();
      if (!user) return;
      const at = Date.now();
      let token = await accessToken();
      let watching: TraktWatching | null;
      try {
        watching = await client.watching(user, token);
      } catch (err) {
        // A token Trakt stopped accepting early: renew it once and retry.
        if (!(token && err instanceof TraktError && err.status === 401)) throw err;
        token = (await refresh()).accessToken;
        watching = await client.watching(user, token);
      }
      const result: PollResult = { at, user, watching };
      const activity = watching ? toNowPlaying(watching, { name: config.activityName, templates: config }) : undefined;
      if (watching && activity) {
        const artwork = await resolver.resolve(watching);
        const text = imageText(watching);
        if (artwork.url) activity.largeImage = { url: artwork.url, ...(text && { text }) };
        if (config.smallImage) activity.smallImage = { url: config.smallImage, text: config.activityName };
        const links = itemLinks(watching, config.buttons);
        if (links.length) activity.links = links;
        result.activity = activity;
        result.artwork = artwork;
      }
      if (ctx.signal.aborted) return;
      last = result;
      ctx.publish(result.activity ?? null);
    }

    async function loop(gen: number): Promise<void> {
      let delay = config.pollSeconds * 1000;
      try {
        await poll();
        if (lastError) log.info('Trakt is reachable again');
        lastError = undefined;
        failures = 0;
      } catch (err) {
        const msg = errorMessage(err);
        if (msg !== lastError) log.error(msg);
        lastError = msg;
        if (err instanceof TraktAuthError) {
          disconnect(msg);
          ctx.publish(null);
        } else if (++failures >= MAX_FAILURES) {
          ctx.publish(null);
        }
        // Wait as long as Trakt asks (429s), otherwise back off.
        const retryAfter = err instanceof TraktError ? err.retryAfterMs : undefined;
        delay = retryAfter !== undefined ? Math.max(retryAfter, delay) : Math.min(delay * 2 ** failures, MAX_BACKOFF_MS);
      }
      if (!ctx.signal.aborted && gen === generation && target()) timer = setTimeout(() => void loop(gen), delay);
    }

    function restartPolling(): void {
      clearTimeout(timer);
      failures = 0;
      const gen = ++generation;
      if (config.clientId && target()) void loop(gen);
    }

    // ---- device code sign-in ----------------------------------------------------------------------

    async function connected(tokens: TokenSet): Promise<void> {
      save({ tokens, pending: undefined });
      authError = undefined;
      let account: string | undefined;
      try {
        const me = await client.me(tokens.accessToken);
        account = me.username ?? me.ids?.slug;
        save({ account });
      } catch (err) {
        log.warn(`Connected, but could not read the Trakt profile: ${errorMessage(err)}`);
      }
      log.info(`Connected to Trakt${account ? ` as ${account}` : ''}`);
      if (!ctx.signal.aborted) restartPolling();
    }

    /** Poll for the token at the code's interval until it's entered, denied or expired. */
    async function checkDevice(): Promise<void> {
      const p = read().pending;
      if (!p || ctx.signal.aborted) return;
      if (Date.now() >= p.expiresAt) {
        save({ pending: undefined });
        authError = 'The code expired before it was entered. Connect again.';
        return;
      }
      let delay = deviceDelay;
      try {
        const r = await client.pollDeviceToken(p.deviceCode);
        if (read().pending?.deviceCode !== p.deviceCode) return; // cancelled meanwhile
        if (r.status === 'ok') {
          // Save the tokens even if we're stopping: the code can't be used twice.
          await connected(r.tokens);
          return;
        }
        if (r.status === 'failed') {
          save({ pending: undefined });
          // A restart can race a successful poll; then the code shows as used, but we're connected.
          if (!read().tokens) {
            authError = r.message;
            log.warn(`Connecting to Trakt failed: ${r.message}`);
          }
          return;
        }
        if (r.status === 'slow_down') {
          deviceDelay += 5_000;
          delay = Math.max(r.retryAfterMs ?? 0, deviceDelay);
        }
      } catch (err) {
        // Network or server trouble: keep trying until the code expires.
        log.warn(`Checking the Trakt code failed: ${errorMessage(err)}`);
        delay = Math.min(deviceDelay * 2, 60_000);
      }
      if (!ctx.signal.aborted) deviceTimer = setTimeout(() => void checkDevice(), Math.min(delay, Math.max(0, p.expiresAt - Date.now())));
    }

    function startDevicePolling(p: DeviceCode): void {
      clearTimeout(deviceTimer);
      deviceDelay = p.interval * 1000;
      deviceTimer = setTimeout(() => void checkDevice(), deviceDelay);
    }

    const back = `/instances/${ctx.instanceId}`;
    const fail = (msg: string) => `${back}?error=${encodeURIComponent(msg)}`;

    return {
      start() {
        const p = pendingCode();
        if (config.clientId && p) startDevicePolling(p);
        restartPolling();
      },
      stop() {
        clearTimeout(timer);
        clearTimeout(deviceTimer);
      },
      status() {
        if (!config.clientId) return { health: 'setup' as const, message: 'Set the Trakt client ID' };
        const p = pendingCode();
        if (p) return { health: 'setup' as const, message: `Enter the code ${p.userCode} at ${p.verificationUrl}` };
        if (!target()) {
          return { health: authError ? ('error' as const) : ('setup' as const), message: authError ?? 'Set your Trakt username, or connect your account' };
        }
        if (lastError) return { health: 'error' as const, message: lastError };
        if (!last) return { health: 'idle' as const, message: 'Connecting…' };
        if (last.activity) {
          return { health: 'ok' as const, message: `${last.watching?.action === 'checkin' ? 'Checked in to' : 'Watching'} ${last.activity.title}` };
        }
        return { health: 'idle' as const, message: 'Not watching anything' };
      },

      routes(app: Hono) {
        app.post('/test', async (c) => {
          const user = target();
          if (!config.clientId || !user) return c.redirect(fail('Set the client ID and a username (or connect your account) first.'));
          try {
            const watching = await client.watching(user, await accessToken());
            const item = watching && (imageText(watching) ?? 'something');
            return c.redirect(`${back}?message=${encodeURIComponent(`Connected to Trakt: ${item ? `watching ${item}` : 'nothing playing right now'}.`)}`);
          } catch (err) {
            return c.redirect(fail(errorMessage(err)));
          }
        });

        app.post('/connect', async (c) => {
          if (!config.clientId) return c.redirect(fail('Set the client ID first.'));
          try {
            const p = await client.deviceCode();
            await write({ pending: p });
            authError = undefined;
            startDevicePolling(p);
          } catch (err) {
            return c.redirect(fail(`Could not start connecting: ${errorMessage(err)}`));
          }
          return c.redirect(back);
        });

        app.post('/connect/cancel', async (c) => {
          clearTimeout(deviceTimer);
          await write({ pending: undefined });
          return c.redirect(back);
        });

        app.post('/disconnect', async (c) => {
          const tokens = disconnect();
          if (tokens) await client.revoke(tokens.accessToken).catch((err: unknown) => log.warn(`Could not revoke the Trakt token: ${errorMessage(err)}`));
          log.info('Disconnected from Trakt');
          last = undefined;
          lastError = undefined;
          ctx.publish(null);
          restartPolling();
          return c.redirect(`${back}?message=${encodeURIComponent('Disconnected; the tokens were deleted.')}`);
        });
      },

      panel() {
        const s = read();
        if (!config.clientId) {
          return (
            <div class="card">
              <h2>Create a Trakt API app</h2>
              <p>
                <a href={NEW_APP_URL}>Create an API app</a> on Trakt (any name; for the redirect URI enter{' '}
                <code>urn:ietf:wg:oauth:2.0:oob</code>), then copy its <strong>Client ID</strong> into the settings below and save.
              </p>
            </div>
          );
        }
        const test = (
          <form class="inline" method="post" action={`${ctx.routeBase}/test`}>
            <button class="secondary">Test connection</button>
          </form>
        );
        return (
          <div class="card">
            <h2>Trakt account</h2>
            {authError && <Notice kind="error">{authError}</Notice>}
            {s.tokens ? (
              <>
                <p>
                  Connected{s.account ? <> as <strong>{s.account}</strong></> : ''}. Showing{' '}
                  {config.username ? <strong>{config.username}</strong> : 'this account'}.
                </p>
                <div class="actions">
                  {test}
                  <form class="inline" method="post" action={`${ctx.routeBase}/disconnect`}>
                    <button class="danger">Disconnect</button>
                  </form>
                </div>
              </>
            ) : pendingCode() ? (
              <>
                <p>Enter the code shown above on Trakt. This page updates once you've approved it.</p>
                <form class="inline" method="post" action={`${ctx.routeBase}/connect/cancel`}>
                  <button class="secondary">Cancel</button>
                </form>
              </>
            ) : (
              <>
                <p>
                  A public profile only needs your username below. For a private profile, connect your account; you'll get a code to enter
                  on Trakt.
                </p>
                <div class="actions">
                  <form class="inline" method="post" action={`${ctx.routeBase}/connect`}>
                    <button>Connect Trakt</button>
                  </form>
                  {config.username && test}
                </div>
              </>
            )}
          </div>
        );
      },

      live() {
        const p = pendingCode();
        if (!p && !last) return null;
        return (
          <div class="card">
            {p && (
              <>
                <h2>Connect your Trakt account</h2>
                <p>
                  Go to{' '}
                  <a href={p.verificationUrl} target="_blank" rel="noreferrer">
                    {p.verificationUrl}
                  </a>{' '}
                  and enter <code style="font-size: 1.4em">{p.userCode}</code>
                </p>
                <p class="small muted">The code expires in {Math.max(1, Math.round((p.expiresAt - Date.now()) / 60_000))} min.</p>
              </>
            )}
            {last && (
              <>
                <h2>Watching</h2>
                <p class="small muted">
                  Last checked {timeAgo(last.at)} ({last.user === 'me' ? 'connected account' : last.user}).
                </p>
                {last.activity ? (
                  <div class="preview">
                    {last.activity.largeImage && <img src={last.activity.largeImage.url} alt="" />}
                    <div>
                      <div><strong>{last.activity.title}</strong></div>
                      {last.activity.subtitle && <div>{last.activity.subtitle}</div>}
                      <div class="small muted">
                        {last.watching?.action === 'checkin' ? 'Check-in' : 'Scrobble'} · Artwork: {last.artwork?.source ?? 'none'}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p class="muted">Nothing is being watched.</p>
                )}
              </>
            )}
          </div>
        );
      },
    };
  }

  return defineSource({
    id: 'trakt',
    name: 'Trakt',
    description: 'What you are watching, from anything that scrobbles to Trakt (Infuse, Kodi, browser extensions, …).',
    configSchema,
    multiple: true,
    create: createTrakt,
  });
}

export const traktPlugin = createTraktPlugin();
