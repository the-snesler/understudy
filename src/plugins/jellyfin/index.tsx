import crypto from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { NowPlaying } from '../../core/activity.js';
import { errorMessage } from '../../core/log.js';
import { defineSource, type SourceContext } from '../../core/plugin.js';
import { timeAgo } from '../../web/layout.js';
import { stabiliseTimestamps } from '../shared/timestamps.js';
import { ArtworkResolver, signItem, verifyItem, type Artwork } from './artwork.js';
import { JellyfinClient, type JellyfinSession } from './client.js';
import { chooseSession, isPlaying, matchesFilter, mediaKind, toNowPlaying } from './session.js';

const template = (title: string, value: string, description: string) =>
  z.string().default(value).meta({ title, description });

const VARS_HELP =
  'Variables: {title} {year} {show} {season} {episode} {seasonPadded} {episodePadded} {episodeTitle} {track} {artist} {albumArtist} {album} {genre} {genres} {studio} {rating} {user} {client} {device}. Text in [brackets] is dropped if a variable inside is empty.';

const configSchema = z.object({
  serverType: z
    .enum(['Jellyfin', 'Emby'])
    .default('Jellyfin')
    .meta({ title: 'Server type', description: 'They share an API, but authenticate differently.' }),
  url: z
    .string()
    .trim()
    .regex(/^(https?:\/\/\S+)?$/, 'Must start with http:// or https://')
    .default('')
    .meta({ title: 'Server URL', description: 'e.g. http://jellyfin:8096, including the base URL if you set one. For Emby, leave off /emby.' }),
  apiKey: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'API key', description: 'Jellyfin: Dashboard → API Keys. Emby: Settings → API Keys.', secret: true }),
  users: z
    .array(z.string().trim().min(1))
    .default([])
    .meta({
      title: 'Users',
      description: 'Usernames to show, one per line. Leave empty to show anyone playing on your server.',
    }),
  clients: z
    .array(z.string().trim().min(1))
    .default([])
    .meta({
      title: 'Clients or devices',
      description: 'Only show playback from these app names (e.g. "Jellyfin Web") or device names, one per line. Leave empty for any.',
    }),
  pollSeconds: z.number().int().min(5).max(300).default(15).meta({ title: 'Poll interval (seconds)', description: 'How often to ask the server what is playing.' }),
  activityName: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Activity name', description: 'Shown as "Watching <name>". Leave empty for the server type ("Jellyfin" or "Emby").' }),
  movieTitle: template('Movie: first line', '{title}[ ({year})]', VARS_HELP),
  movieSubtitle: template('Movie: second line', '[{genre}] · [{studio}]', ''),
  episodeTitle: template('Episode: first line', '{show}', ''),
  episodeSubtitle: template('Episode: second line', '[S{seasonPadded}E{episodePadded}][ · {episodeTitle}]', ''),
  trackTitle: template('Track: first line', '{track}', 'Also used for music videos.'),
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
      title: 'Serve server artwork through this app',
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
    .meta({ title: 'Small image', description: 'Badge in the corner of the artwork: a square HTTPS image URL or a Discord app asset key (e.g. "jellyfin").' }),
  links: z.boolean().default(true).meta({ title: 'IMDb/TMDB button', description: 'Add a button linking to the movie or show.' }),
});

type Config = z.infer<typeof configSchema>;

interface PollResult {
  at: number;
  sessions: JellyfinSession[];
  matched: JellyfinSession[];
  chosen?: JellyfinSession;
  activity?: NowPlaying;
  artwork?: Artwork;
}

/** Give up showing the last activity after this many failed polls in a row. */
const MAX_FAILURES = 3;
/** Ignore timestamp drift smaller than this between polls (clients report progress every ~10 s). */
const DRIFT_MS = 15_000;

function createJellyfin(ctx: SourceContext<Config>) {
  const { config, log } = ctx;
  const server = config.serverType;
  const name = config.activityName || server;
  const configured = !!config.url && !!config.apiKey;
  const client = new JellyfinClient(server, config.url, config.apiKey);

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
    proxyUrl: proxyUsable
      ? (itemId) => {
          const token = signItem(itemId, artSecret);
          return token && `${publicUrl}${ctx.publicBase}/art/${token}`;
        }
      : undefined,
    fallback: config.fallbackImage || undefined,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: PollResult | undefined;
  let lastError: string | undefined;
  let failures = 0;
  let published: NowPlaying | undefined;

  async function poll(): Promise<void> {
    const at = Date.now();
    // Idle sessions (open apps playing nothing) aren't worth listing.
    const sessions = (await client.sessions()).filter(isPlaying);
    const matched = sessions.filter((s) => matchesFilter(s, config));
    const chosen = chooseSession(matched);
    const result: PollResult = { at, sessions, matched, chosen };
    if (chosen) {
      const item = chosen.NowPlayingItem!;
      const activity = toNowPlaying(chosen, { name, templates: config, now: at });
      stabiliseTimestamps(activity, published, DRIFT_MS);
      const artwork = await resolver.resolve(chosen);
      const kind = mediaKind(item);
      const imageText = kind === 'track' ? item.Album : kind === 'episode' ? item.SeriesName : item.Name;
      if (artwork.url) activity.largeImage = { url: artwork.url, ...(imageText && { text: imageText }) };
      if (config.smallImage) activity.smallImage = { url: config.smallImage, text: name };
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
      if (lastError) log.info(`${server} is reachable again`);
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
      if (!configured) return { health: 'setup' as const, message: `Set the ${server} URL and API key` };
      if (lastError) return { health: 'error' as const, message: lastError };
      if (!last) return { health: 'idle' as const, message: 'Connecting…' };
      if (last.chosen) {
        const s = last.chosen;
        return {
          health: 'ok' as const,
          message: `${s.PlayState?.IsPaused ? 'Paused' : 'Playing'} on ${s.DeviceName ?? s.Client ?? 'a device'} (${s.UserName ?? '?'})`,
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
          const sessions = await client.sessions();
          const playing = sessions.filter(isPlaying).length;
          return c.redirect(`${back}?message=${encodeURIComponent(`Connected to ${server}: ${sessions.length} session(s), ${playing} playing.`)}`);
        } catch (err) {
          return c.redirect(`${back}?error=${encodeURIComponent(errorMessage(err))}`);
        }
      });
    },

    publicRoutes(app: Hono) {
      // Artwork for Discord: only items this instance signed, fetched server-side from the server.
      app.get('/art/:token', async (c) => {
        if (!proxyUsable) return c.text('Not found', 404);
        const itemId = verifyItem(c.req.param('token'), artSecret);
        if (!itemId) return c.text('Not found', 404);
        try {
          const img = await client.image(itemId, { width: 600, height: 600 });
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
          {!config.users.length && <span class="muted small">Showing playback from every user on the server; set Users below to limit it.</span>}
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
                  <th>Client</th>
                  <th>State</th>
                  <th>Item</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {last.sessions.map((s) => (
                  <tr>
                    <td>{s.UserName}</td>
                    <td>
                      {s.Client}
                      {s.DeviceName && <span class="small muted"> on {s.DeviceName}</span>}
                    </td>
                    <td>{s.PlayState?.IsPaused ? 'paused' : 'playing'}</td>
                    <td>{[s.NowPlayingItem?.SeriesName, s.NowPlayingItem?.Name].filter(Boolean).join(' - ')}</td>
                    <td class="small">{s === last!.chosen ? 'shown' : last!.matched.includes(s) ? 'matched' : 'filtered out'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="muted">Nothing playing.</p>
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

export const jellyfinPlugin = defineSource({
  id: 'jellyfin',
  name: 'Jellyfin / Emby',
  description: "What's playing on your Jellyfin or Emby server.",
  configSchema,
  multiple: true,
  create: createJellyfin,
});
