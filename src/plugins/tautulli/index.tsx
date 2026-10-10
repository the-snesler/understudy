import crypto from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { NowPlaying } from '../../core/activity.js';
import { errorMessage } from '../../core/log.js';
import { defineSource, type SourceContext } from '../../core/plugin.js';
import { timeAgo } from '../../web/layout.js';
import { stabiliseTimestamps } from '../shared/timestamps.js';
import { ArtworkResolver, signThumb, verifyThumb, type Artwork } from './artwork.js';
import { TautulliClient, type TautulliSession } from './client.js';
import { chooseSession, matchesFilter, mediaKind, toNowPlaying } from './session.js';

const template = (title: string, value: string, description: string) =>
  z.string().default(value).meta({ title, description });

const VARS_HELP =
  'Variables: {title} {year} {show} {season} {episode} {seasonPadded} {episodePadded} {episodeTitle} {track} {artist} {album} {genre} {genres} {director} {directors} {studio} {user} {player} {library}. Text in [brackets] is dropped if a variable inside is empty.';

const configSchema = z.object({
  url: z
    .string()
    .trim()
    .regex(/^(https?:\/\/\S+)?$/, 'Must start with http:// or https://')
    .default('')
    .meta({ title: 'Tautulli URL', description: 'e.g. http://tautulli:8181, including the HTTP root if you set one.' }),
  apiKey: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Tautulli API key', description: 'Tautulli → Settings → Web Interface → API.', secret: true }),
  users: z
    .array(z.string().trim().min(1))
    .default([])
    .meta({
      title: 'Users',
      description: 'Plex usernames or Tautulli friendly names to show, one per line. Leave empty to show anyone streaming from your server.',
    }),
  players: z
    .array(z.string().trim().min(1))
    .default([])
    .meta({ title: 'Players', description: 'Only show streams from these player names, one per line. Leave empty for any player.' }),
  pollSeconds: z.number().int().min(5).max(300).default(15).meta({ title: 'Poll interval (seconds)', description: 'How often to ask Tautulli what is playing.' }),
  activityName: z.string().trim().min(1).default('Plex').meta({ title: 'Activity name', description: 'Shown as "Watching <name>".' }),
  movieTitle: template('Movie: first line', '{title}[ ({year})]', VARS_HELP),
  movieSubtitle: template('Movie: second line', '[{genre}] · [Dir. {director}]', ''),
  episodeTitle: template('Episode: first line', '{show}', ''),
  episodeSubtitle: template('Episode: second line', 'S{seasonPadded}E{episodePadded}[ · {episodeTitle}]', ''),
  trackTitle: template('Track: first line', '{track}', ''),
  trackSubtitle: template('Track: second line', '{artist}', ''),
  tmdbKey: z
    .string()
    .trim()
    .default('')
    .meta({
      title: 'TMDB API key (optional)',
      description: 'A TMDB v3 API key or v4 read access token, for movie and show posters (themoviedb.org → Settings → API).',
      secret: true,
    }),
  albumArt: z
    .boolean()
    .default(true)
    .meta({ title: 'Album art from iTunes/Deezer', description: 'Look up album covers in the iTunes and Deezer catalogues (no key needed).' }),
  proxyArt: z
    .boolean()
    .default(false)
    .meta({
      title: 'Serve Plex artwork through this app',
      description:
        'Fallback when TMDB/iTunes/Deezer find nothing. Needs PUBLIC_URL to be an HTTPS address Discord can reach. Only signed image URLs under /public/ are exposed; the rest of the UI stays behind the password.',
    }),
  fallbackImage: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Fallback image', description: 'HTTPS URL or Discord app asset key used when no artwork is found.' }),
  smallImage: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Small image', description: 'Badge in the corner of the artwork: a square HTTPS image URL or a Discord app asset key (e.g. "plex").' }),
  links: z.boolean().default(true).meta({ title: 'IMDb/TMDB button', description: 'Add a button linking to the movie or show.' }),
});

type Config = z.infer<typeof configSchema>;

interface PollResult {
  at: number;
  sessions: TautulliSession[];
  matched: TautulliSession[];
  chosen?: TautulliSession;
  activity?: NowPlaying;
  artwork?: Artwork;
}

/** Give up showing the last activity after this many failed polls in a row. */
const MAX_FAILURES = 3;
/** Ignore timestamp drift smaller than this between polls (Plex reports offsets every ~10 s). */
const DRIFT_MS = 15_000;

function createTautulli(ctx: SourceContext<Config>) {
  const { config, log } = ctx;
  const configured = !!config.url && !!config.apiKey;
  const client = new TautulliClient(config.url, config.apiKey);

  const stored = (ctx.state.get() ?? {}) as { artSecret?: string };
  const artSecret = stored.artSecret ?? crypto.randomBytes(32).toString('base64url');
  if (!stored.artSecret) ctx.state.set({ ...stored, artSecret }).catch((err: unknown) => log.error(`Could not save state: ${errorMessage(err)}`));

  const publicUrl = ctx.env.publicUrl;
  const proxyUsable = config.proxyArt && !!publicUrl?.startsWith('https://');
  const resolver = new ArtworkResolver({
    client,
    log,
    tmdbKey: config.tmdbKey || undefined,
    albumArt: config.albumArt,
    proxyUrl: proxyUsable ? (thumb) => `${publicUrl}${ctx.publicBase}/art/${signThumb(thumb, artSecret)}` : undefined,
    fallback: config.fallbackImage || undefined,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: PollResult | undefined;
  let lastError: string | undefined;
  let failures = 0;
  let published: NowPlaying | undefined;

  async function poll(): Promise<void> {
    const at = Date.now();
    const sessions = await client.activity();
    const matched = sessions.filter((s) => matchesFilter(s, config));
    const chosen = chooseSession(matched);
    const result: PollResult = { at, sessions, matched, chosen };
    if (chosen) {
      const activity = toNowPlaying(chosen, { name: config.activityName, templates: config, now: at });
      stabiliseTimestamps(activity, published, DRIFT_MS);
      const artwork = await resolver.resolve(chosen);
      const kind = mediaKind(chosen);
      const imageText = kind === 'track' ? chosen.parent_title : kind === 'episode' ? chosen.grandparent_title : chosen.title;
      if (artwork.url) activity.largeImage = { url: artwork.url, ...(imageText && { text: imageText }) };
      if (config.smallImage) activity.smallImage = { url: config.smallImage, text: config.activityName };
      if (config.links && artwork.links.length) activity.links = artwork.links;
      result.activity = activity;
      result.artwork = artwork;
    }
    if (ctx.signal.aborted) return;
    last = result;
    published = result.activity;
    ctx.publish(result.activity ?? null);
  }

  async function loop(): Promise<void> {
    try {
      await poll();
      if (lastError) log.info('Tautulli is reachable again');
      lastError = undefined;
      failures = 0;
    } catch (err) {
      const msg = errorMessage(err);
      if (msg !== lastError) log.error(msg);
      lastError = msg;
      if (++failures >= MAX_FAILURES) {
        published = undefined;
        ctx.publish(null);
      }
    }
    if (!ctx.signal.aborted) timer = setTimeout(() => void loop(), config.pollSeconds * 1000);
  }

  return {
    start() {
      if (!configured) return;
      if (config.proxyArt && !proxyUsable) log.warn('Artwork proxy is on, but PUBLIC_URL is not an https:// address; it will not be used.');
      void loop();
    },
    stop() {
      clearTimeout(timer);
    },
    status() {
      if (!configured) return { health: 'setup' as const, message: 'Set the Tautulli URL and API key' };
      if (lastError) return { health: 'error' as const, message: lastError };
      if (!last) return { health: 'idle' as const, message: 'Connecting…' };
      if (last.chosen) {
        const s = last.chosen;
        return {
          health: 'ok' as const,
          message: `${s.state === 'paused' ? 'Paused' : 'Playing'} on ${s.player ?? 'a player'} (${s.friendly_name ?? s.user ?? '?'})`,
        };
      }
      const others = last.sessions.length - last.matched.length;
      return { health: 'idle' as const, message: `Nothing playing${others ? ` (${others} other stream${others > 1 ? 's' : ''} filtered out)` : ''}` };
    },

    routes(app: Hono) {
      app.post('/test', async (c) => {
        const back = `/instances/${ctx.instanceId}`;
        if (!configured) return c.redirect(`${back}?error=${encodeURIComponent('Set the URL and API key first.')}`);
        try {
          const sessions = await client.activity();
          return c.redirect(`${back}?message=${encodeURIComponent(`Connected to Tautulli: ${sessions.length} active stream(s).`)}`);
        } catch (err) {
          return c.redirect(`${back}?error=${encodeURIComponent(errorMessage(err))}`);
        }
      });
    },

    publicRoutes(app: Hono) {
      // Artwork for Discord: only thumbs this instance signed, fetched server-side from Tautulli.
      app.get('/art/:token', async (c) => {
        if (!proxyUsable) return c.text('Not found', 404);
        const thumb = verifyThumb(c.req.param('token'), artSecret);
        if (!thumb) return c.text('Not found', 404);
        try {
          const img = await client.image(thumb, { width: 600, height: 600 });
          return new Response(img.body, {
            headers: {
              'Content-Type': img.headers.get('content-type') ?? 'image/jpeg',
              'Cache-Control': 'public, max-age=86400',
            },
          });
        } catch (err) {
          log.warn(`Artwork proxy: ${errorMessage(err)}`);
          return c.text('Upstream error', 502);
        }
      });
    },

    panel() {
      return (
        <div class="card actions">
          <form class="inline" method="post" action={`${ctx.routeBase}/test`}>
            <button class="secondary">Test connection</button>
          </form>
          {!config.users.length && <span class="muted small">Showing streams from every user on the server; set Users below to limit it.</span>}
        </div>
      );
    },

    live() {
      if (!last) return null;
      return (
        <div class="card">
          <h2>Streams</h2>
          <p class="small muted">Last checked {timeAgo(last.at)}.</p>
          {last.sessions.length ? (
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Player</th>
                  <th>State</th>
                  <th>Item</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {last.sessions.map((s) => (
                  <tr>
                    <td>{s.friendly_name ?? s.user}</td>
                    <td>{s.player}</td>
                    <td>{s.state}</td>
                    <td>{s.full_title ?? s.title}</td>
                    <td class="small">{s === last!.chosen ? 'shown' : last!.matched.includes(s) ? 'matched' : 'filtered out'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="muted">No active streams.</p>
          )}
          {last.activity && (
            <>
              <h2 style="margin-top: 1rem">Published activity</h2>
              <div class="preview">
                {last.activity.largeImage && <img src={last.activity.largeImage.url} alt="" />}
                <div>
                  <div><strong>{last.activity.title}</strong></div>
                  {last.activity.subtitle && <div>{last.activity.subtitle}</div>}
                  <div class="small muted">Artwork: {last.artwork?.source ?? 'none'}</div>
                </div>
              </div>
            </>
          )}
        </div>
      );
    },
  };
}

export const tautulliPlugin = defineSource({
  id: 'tautulli',
  name: 'Plex (Tautulli)',
  description: "What's playing on your Plex server, via Tautulli.",
  configSchema,
  multiple: true,
  create: createTautulli,
});
