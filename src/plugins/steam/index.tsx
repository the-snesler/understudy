import type { Hono } from 'hono';
import { z } from 'zod';
import type { NowPlaying } from '../../core/activity.js';
import { errorMessage } from '../../core/log.js';
import { defineSource, type SourceContext } from '../../core/plugin.js';
import { Notice, timeAgo } from '../../web/layout.js';
import { parseSteamId, SteamClient, SteamError, SteamStore, type PlayerSummary } from './client.js';
import { activityKey, currentGame, isIgnored, toNowPlaying, type SteamGame } from './presence.js';

const API_KEY_URL = 'https://steamcommunity.com/dev/apikey';

const configSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Steam Web API key', description: `From ${API_KEY_URL}. Any domain name will do.`, secret: true }),
  steamId: z
    .string()
    .trim()
    .refine((v) => !v || !!parseSteamId(v), 'Enter a SteamID64, a steamcommunity.com profile URL or a custom URL name')
    .default('')
    .meta({
      title: 'Steam profile',
      description: 'Your SteamID64 (7656119…), profile URL (steamcommunity.com/profiles/… or /id/…), or custom URL name.',
    }),
  pollSeconds: z.number().int().min(15).max(300).default(30).meta({ title: 'Poll interval (seconds)', description: 'How often to ask Steam what you are playing.' }),
  activityName: z.string().trim().min(1).default('Steam').meta({ title: 'Activity name', description: 'Shown as "Playing <name>", e.g. "Steam" or "Steam Deck".' }),
  ignore: z
    .array(z.string().trim().min(1))
    .default([])
    .meta({
      title: 'Ignore games',
      description:
        "App ids or game names not to show, one per line. Useful for games you play on a PC running Discord, which shows them itself. The app id is the number in the game's store URL.",
    }),
  fallbackImage: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Fallback image', description: 'HTTPS URL or Discord app asset key used when the store has no artwork, e.g. for non-Steam games.' }),
  smallImage: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Small image', description: 'Badge in the corner of the game art: a square HTTPS image URL or a Discord app asset key (e.g. "steam").' }),
  storeButton: z.boolean().default(false).meta({ title: 'Steam store button', description: "Add a \"View on Steam\" button linking to the game's store page." }),
});

type Config = z.infer<typeof configSchema>;

interface PersistedState {
  /** What the Steam profile setting resolved to, so a custom URL isn't resolved on every poll. */
  resolved?: { input: string; steamId: string };
  /** The game being shown, so a restart mid-session doesn't reset its timer. */
  session?: Session;
}

interface Session {
  key: string;
  startedAt: number;
  /** Last time the game was seen in a poll. */
  seenAt: number;
}

interface PollResult {
  at: number;
  player: PlayerSummary;
  game?: SteamGame;
  ignored?: boolean;
  activity?: NowPlaying;
  artwork?: 'store' | 'fallback';
}

/** Give up showing the last activity after this many failed polls in a row. */
const MAX_FAILURES = 3;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
/** A game seen again within this long counts as the same session (e.g. across a restart or an outage). */
const RESUME_MS = 15 * 60 * 1000;
/** How often to save when the current game was last seen. */
const SAVE_SEEN_MS = 5 * 60 * 1000;

const PERSONA_STATES = ['Offline', 'Online', 'Busy', 'Away', 'Snooze', 'Looking to trade', 'Looking to play'];

export function createSteamPlugin(fetchImpl?: typeof fetch) {
  /** Store details are cached across instances and restarts: the store API is rate limited per IP. */
  const store = new SteamStore(fetchImpl);

  function createSteam(ctx: SourceContext<Config>) {
    const { config, log } = ctx;
    const configured = !!config.apiKey && !!config.steamId;
    const client = new SteamClient(config.apiKey, fetchImpl);
    const read = (): PersistedState => (ctx.state.get() ?? {}) as PersistedState;
    const write = (patch: Partial<PersistedState>) =>
      ctx.state.set({ ...read(), ...patch }).catch((err: unknown) => log.error(`Could not save state: ${errorMessage(err)}`));

    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: PollResult | undefined;
    let lastError: string | undefined;
    let failures = 0;
    let session: Session | undefined;
    let savedSeenAt = 0;

    async function resolveId(): Promise<string> {
      const input = config.steamId;
      const parsed = parseSteamId(input);
      if (!parsed) throw new SteamError('Enter a SteamID64, profile URL or custom URL name');
      if ('steamId' in parsed) return parsed.steamId;
      const cached = read().resolved;
      if (cached?.input === input) return cached.steamId;
      const steamId = await client.resolveVanity(parsed.vanity);
      log.info(`Resolved Steam custom URL "${parsed.vanity}" to ${steamId}`);
      void write({ resolved: { input, steamId } });
      return steamId;
    }

    /** When the game was first seen: kept across polls, and across restarts if seen recently. */
    function startedAt(key: string, now: number): number {
      if (session?.key !== key || now - session.seenAt > RESUME_MS) {
        const saved = read().session;
        const resume = saved?.key === key && now - saved.seenAt <= RESUME_MS;
        session = { key, startedAt: resume ? saved.startedAt : now, seenAt: now };
        savedSeenAt = 0;
      }
      session.seenAt = now;
      if (now - savedSeenAt >= SAVE_SEEN_MS) {
        savedSeenAt = now;
        void write({ session: { ...session } });
      }
      return session.startedAt;
    }

    async function poll(): Promise<void> {
      const at = Date.now();
      const steamId = await resolveId();
      const player = await client.summary(steamId);
      const game = currentGame(player);
      const result: PollResult = { at, player, game };
      if (game && !isIgnored(game, config.ignore)) {
        const app = game.appId ? await store.app(game.appId) : undefined;
        if (!game.name && app?.name) game.name = app.name;
        if (isIgnored(game, config.ignore)) result.ignored = true;
        else {
          const image = app?.headerImage ?? (config.fallbackImage || undefined);
          const opts = { ...config, storeButton: config.storeButton && app !== null };
          result.activity = toNowPlaying(steamId, game, opts, image, startedAt(activityKey(steamId, game), at));
          if (image) result.artwork = app?.headerImage ? 'store' : 'fallback';
        }
      } else if (game) {
        result.ignored = true;
      }
      if (ctx.signal.aborted) return;
      if (!result.activity && session) {
        session = undefined;
        void write({ session: undefined });
      }
      last = result;
      ctx.publish(result.activity ?? null);
    }

    async function loop(): Promise<void> {
      let delay = config.pollSeconds * 1000;
      try {
        await poll();
        if (lastError) log.info('Steam is reachable again');
        lastError = undefined;
        failures = 0;
      } catch (err) {
        const msg = errorMessage(err);
        if (msg !== lastError) log.error(msg);
        lastError = msg;
        if (++failures >= MAX_FAILURES) ctx.publish(null);
        const retryAfter = err instanceof SteamError ? err.retryAfterMs : undefined;
        delay = retryAfter !== undefined ? Math.max(retryAfter, delay) : Math.min(delay * 2 ** failures, MAX_BACKOFF_MS);
      }
      if (!ctx.signal.aborted) timer = setTimeout(() => void loop(), delay);
    }

    const hiddenHint = (p: PlayerSummary) =>
      p.communityvisibilitystate !== 3 ? " Steam says this profile isn't visible to the API key's account, so it may hide the game you're in." : '';

    return {
      start() {
        if (configured) void loop();
      },
      stop() {
        clearTimeout(timer);
        // Remember when the game was last seen, so a quick restart keeps its timer.
        if (session) void write({ session: { ...session } });
      },
      status() {
        if (!configured) return { health: 'setup' as const, message: 'Set the Steam Web API key and profile' };
        if (lastError) return { health: 'error' as const, message: lastError };
        if (!last) return { health: 'idle' as const, message: 'Connecting…' };
        const who = last.player.personaname ?? 'You';
        if (last.activity) return { health: 'ok' as const, message: `${who} is playing ${last.activity.title}` };
        if (last.ignored) return { health: 'idle' as const, message: `${who} is playing ${last.game?.name ?? 'an ignored game'} (ignored)` };
        const hint = hiddenHint(last.player);
        return { health: hint ? ('warning' as const) : ('idle' as const), message: `${who} isn't playing anything.${hint}` };
      },

      routes(app: Hono) {
        app.post('/test', async (c) => {
          const back = `/instances/${ctx.instanceId}`;
          if (!configured) return c.redirect(`${back}?error=${encodeURIComponent('Set the API key and Steam profile first.')}`);
          try {
            const player = await client.summary(await resolveId());
            const game = currentGame(player);
            const msg = `Connected to Steam as ${player.personaname ?? player.steamid}${game ? `, playing ${game.name ?? game.gameId}` : ''}.${hiddenHint(player)}`;
            return c.redirect(`${back}?message=${encodeURIComponent(msg)}`);
          } catch (err) {
            return c.redirect(`${back}?error=${encodeURIComponent(errorMessage(err))}`);
          }
        });
      },

      panel() {
        return (
          <div class="card actions">
            <form class="inline" method="post" action={`${ctx.routeBase}/test`}>
              <button class="secondary">Test connection</button>
            </form>
            <span class="muted small">
              Get a key at <a href={API_KEY_URL}>steamcommunity.com/dev/apikey</a>. Your profile's <strong>Game details</strong> must be
              visible to the key's account.
            </span>
          </div>
        );
      },

      live() {
        if (!last) return null;
        const p = last.player;
        const a = last.activity;
        const img = a?.largeImage?.url.startsWith('https://') ? a.largeImage.url : p.avatarfull;
        return (
          <div class="card">
            <h2>{p.personaname ?? p.steamid}</h2>
            {p.communityvisibilitystate !== 3 && <Notice kind="error">{hiddenHint(p).trim()}</Notice>}
            <div class="preview">
              {img && <img src={img} alt="" />}
              <div>
                <div>
                  {PERSONA_STATES[p.personastate ?? 0] ?? 'Online'}
                  {last.game && ` · playing ${last.game.name ?? last.game.gameId}${last.ignored ? ' (ignored)' : ''}`}
                </div>
                {a && (
                  <div class="small muted">
                    Published: {a.name} · {a.title} · artwork: {last.artwork ?? 'none'}
                  </div>
                )}
                {store.lastError && <div class="small muted">{store.lastError}</div>}
                <div class="small muted">Checked {timeAgo(last.at)}.</div>
              </div>
            </div>
          </div>
        );
      },
    };
  }

  return defineSource({
    id: 'steam',
    name: 'Steam',
    description: 'What you are playing on Steam (e.g. on a Steam Deck), via the Steam Web API.',
    configSchema,
    multiple: true,
    create: createSteam,
  });
}

export const steamPlugin = createSteamPlugin();
