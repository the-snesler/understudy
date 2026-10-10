import crypto from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { NowPlaying } from '../../core/activity.js';
import { errorMessage } from '../../core/log.js';
import { renderTemplate } from '../../core/template.js';
import { defineSource, type SourceContext } from '../../core/plugin.js';
import { timeAgo } from '../../web/layout.js';
import { Icon } from '../../web/icons.js';
import { stabiliseTimestamps } from '../shared/timestamps.js';
import { ArtworkResolver, signThumb, verifyThumb, type Artwork } from './artwork.js';
import { TautulliClient, type TautulliSession } from './client.js';
import { PlexLinks } from './plex-links.js';
import { chooseSession, matchesFilter, mediaKind, templateVars, toNowPlaying } from './session.js';

const CONNECTION = { title: 'Connection', description: 'Where Understudy finds Tautulli.' };
const STREAMS = { title: 'Whose streams', description: 'Leave a list empty to allow everyone or everything.' };
const TEMPLATES = { title: 'How it reads', description: 'The two lines under the activity name, for each kind of media.' };
const ARTWORK = { title: 'Artwork and links', description: 'Tried in numbered order until one finds a picture.' };
const VARIABLES = {
  Movie: ['title', 'year', 'genre', 'genres', 'director', 'directors', 'studio', 'user', 'player', 'library'],
  Episode: ['show', 'season', 'episode', 'seasonPadded', 'episodePadded', 'episodeTitle', 'year', 'user', 'player', 'library'],
  Track: ['track', 'artist', 'album', 'year', 'genre', 'user', 'player', 'library'],
};
const template = (title: string, value: string, tab: keyof typeof VARIABLES) =>
  z.string().default(value).meta({ title, group: TEMPLATES, widget: 'template', templateTab: tab, variables: VARIABLES[tab] });

const configSchema = z.object({
  url: z.string().trim().regex(/^(https?:\/\/\S+)?$/, 'Must start with http:// or https://').default('')
    .meta({ title: 'Tautulli URL', group: CONNECTION, placeholder: 'http://tautulli:8181' }),
  apiKey: z.string().trim().default('')
    .meta({ title: 'API key', group: CONNECTION, description: 'In Tautulli: Settings → Web Interface → API.', secret: true }),
  pollSeconds: z.number().int().min(5).max(300).default(15)
    .meta({ title: 'Check every', group: CONNECTION, widget: 'segmented', options: [5, 15, 30, 60], labels: { '5': '5s', '15': '15s', '30': '30s', '60': '60s' } }),
  users: z.array(z.string().trim().min(1)).default([])
    .meta({ title: 'Users', group: STREAMS, widget: 'chips', placeholder: 'Add a Plex username or Tautulli name' }),
  players: z.array(z.string().trim().min(1)).default([])
    .meta({ title: 'Players', group: STREAMS, widget: 'chips', placeholder: 'Any player' }),
  activityName: z.string().trim().min(1).default('Plex')
    .meta({ title: 'Activity name', group: TEMPLATES, description: 'Shows as “Watching Plex” or “Listening to Plex”.' }),
  movieTitle: template('First line', '{title}[ ({year})]', 'Movie'),
  movieSubtitle: template('Second line', '[{genre}] · [Dir. {director}]', 'Movie'),
  episodeTitle: template('First line', '{show}', 'Episode'),
  episodeSubtitle: template('Second line', 'S{seasonPadded}E{episodePadded}[ · {episodeTitle}]', 'Episode'),
  trackTitle: template('First line', '{track}', 'Track'),
  trackSubtitle: template('Second line', '{artist}', 'Track'),
  tmdbEnabled: z.boolean().default(true).meta({ title: 'Posters from TMDB', group: ARTWORK, order: 1, description: 'Movies and shows. Needs a TMDB API key or read access token.' }),
  tmdbKey: z.string().trim().default('')
    .meta({ title: 'TMDB API key', group: ARTWORK, description: 'A TMDB API key or read access token.', secret: true, disabledIf: { field: 'tmdbEnabled', equals: false } }),
  albumArt: z.boolean().default(true)
    .meta({ title: 'Album art from iTunes and Deezer', group: ARTWORK, order: 2, description: 'Music. No key needed.' }),
  proxyArt: z.boolean().default(false)
    .meta({ title: 'Plex’s own artwork, served by Understudy', group: ARTWORK, order: 3, description: 'Only signed image links under /public/ are exposed. Needs PUBLIC_URL to be an HTTPS address Discord can reach.' }),
  fallbackImage: z.string().trim().default('')
    .meta({ title: 'Fallback image', group: ARTWORK, placeholder: 'HTTPS URL or Discord asset key', description: 'Used when nothing above finds one.' }),
  smallImage: z.string().trim().default('')
    .meta({ title: 'Corner badge', group: ARTWORK, placeholder: 'e.g. plex', description: 'Small square image over the artwork.' }),
  plexButton: z.boolean().default(true)
    .meta({ title: 'View on Plex button', group: ARTWORK, description: 'Links to Plex Discover for movies and TV, or Plexamp for music.' }),
  links: z.boolean().default(true)
    .meta({ title: 'IMDb / TMDB button', group: ARTWORK, description: 'Adds a link to the movie or show.' }),
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

  const stored = (ctx.state.get() ?? {}) as { artSecret?: string; seenPlayers?: string[] };
  const artSecret = stored.artSecret ?? crypto.randomBytes(32).toString('base64url');
  if (!stored.artSecret) ctx.state.set({ ...stored, artSecret }).catch((err: unknown) => log.error(`Could not save state: ${errorMessage(err)}`));

  const publicUrl = ctx.env.publicUrl;
  const proxyUsable = config.proxyArt && !!publicUrl?.startsWith('https://');
  const resolver = new ArtworkResolver({
    client,
    log,
    tmdbKey: config.tmdbEnabled ? config.tmdbKey || undefined : undefined,
    albumArt: config.albumArt,
    proxyUrl: proxyUsable ? (thumb) => `${publicUrl}${ctx.publicBase}/art/${signThumb(thumb, artSecret)}` : undefined,
    fallback: config.fallbackImage || undefined,
  });
  const plexLinks = new PlexLinks(log);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: PollResult | undefined;
  let lastError: string | undefined;
  let failures = 0;
  let published: NowPlaying | undefined;
  let lastSuccessAt: number | undefined;
  let seenPlayers = stored.seenPlayers ?? [];

  function rememberPlayers(sessions: TautulliSession[]) {
    const current = sessions.map((session) => session.player?.trim()).filter((player): player is string => !!player);
    const next = [...new Set([...current, ...seenPlayers])].slice(0, 20);
    if (JSON.stringify(next) === JSON.stringify(seenPlayers)) return;
    seenPlayers = next;
    ctx.state.set({ ...(ctx.state.get() ?? {}), artSecret, seenPlayers }).catch((err: unknown) => log.warn(`Could not remember players: ${errorMessage(err)}`));
  }

  async function poll(): Promise<void> {
    const at = Date.now();
    const sessions = await client.activity();
    if (ctx.signal.aborted) return;
    rememberPlayers(sessions);
    lastSuccessAt = Date.now();
    ctx.reportSuccess?.();
    const matched = sessions.filter((s) => matchesFilter(s, config));
    const chosen = chooseSession(matched);
    const result: PollResult = { at, sessions, matched, chosen };
    if (chosen) {
      const activity = toNowPlaying(chosen, { name: config.activityName, templates: config, now: at });
      stabiliseTimestamps(activity, published, DRIFT_MS);
      const [artwork, plexLink] = await Promise.all([
        resolver.resolve(chosen),
        config.plexButton ? plexLinks.resolve(chosen) : undefined,
      ]);
      const kind = mediaKind(chosen);
      const imageText = kind === 'track' ? chosen.parent_title : kind === 'episode' ? chosen.grandparent_title : chosen.title;
      if (artwork.url) activity.largeImage = { url: artwork.url, ...(imageText && { text: imageText }) };
      if (config.smallImage) activity.smallImage = { url: config.smallImage, text: config.activityName };
      const links = [...(plexLink ? [plexLink] : []), ...(config.links ? artwork.links : [])];
      if (links.length) activity.links = links;
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
      if (!last) return { health: 'idle' as const, lastSuccessAt, message: lastSuccessAt ? 'Connected; waiting for the next check' : 'Connecting…' };
      if (last.chosen) {
        const s = last.chosen;
        return {
          health: 'ok' as const,
          lastSuccessAt,
          message: `${s.state === 'paused' ? 'Paused' : 'Playing'} on ${s.player ?? 'a player'} (${s.friendly_name ?? s.user ?? '?'})`,
        };
      }
      const others = last.sessions.length - last.matched.length;
      return { health: 'idle' as const, lastSuccessAt, message: `Nothing playing${others ? ` (${others} other stream${others > 1 ? 's' : ''} filtered out)` : ''}` };
    },

    formContext() {
      return {
        suggestions: { players: seenPlayers },
        notes: { url: <div hx-get={`${ctx.routeBase}/connection-status`} hx-trigger="every 3s" hx-swap="innerHTML">{lastSuccessAt && !lastError ? <div class="help text-success">Reachable · checked {timeAgo(lastSuccessAt)}</div> : lastError ? <div class="help field-error">{lastError}</div> : null}</div> },
      };
    },

    routes(app: Hono) {
      app.get('/connection-status', (c) => c.html(lastSuccessAt && !lastError ? <div class="help text-success">Reachable · checked {timeAgo(lastSuccessAt)}</div> : lastError ? <div class="help field-error">{lastError}</div> : <span class="help">Not checked yet.</span>));
      app.post('/template-preview', async (c) => {
        const kind = c.req.query('kind');
        if (kind !== 'movie' && kind !== 'episode' && kind !== 'track') return c.text('Unknown media kind', 400);
        const form = await c.req.parseBody();
        const stream = last?.sessions.find((session) => mediaKind(session) === kind);
        if (!stream) return c.html(<span class="muted small">Start {kind === 'episode' ? 'an' : 'a'} {kind} stream to preview these lines.</span>);
        const firstKey = `${kind}Title` as keyof Config;
        const secondKey = `${kind}Subtitle` as keyof Config;
        const first = typeof form[`cfg.${firstKey}`] === 'string' ? String(form[`cfg.${firstKey}`]) : String(config[firstKey]);
        const second = typeof form[`cfg.${secondKey}`] === 'string' ? String(form[`cfg.${secondKey}`]) : String(config[secondKey]);
        const vars = templateVars(stream);
        return c.html(<div class="template-preview-content"><span class="small muted">Preview</span><div><strong>{renderTemplate(first, vars) || 'Empty first line'}</strong><div>{renderTemplate(second, vars)}</div></div></div>);
      });

      app.post('/test', async (c) => {
        const back = `/instances/${ctx.instanceId}`;
        if (!configured) return c.redirect(`${back}?error=${encodeURIComponent('Set the URL and API key first.')}`);
        try {
          const sessions = await client.activity();
          rememberPlayers(sessions);
          lastSuccessAt = Date.now();
          lastError = undefined;
          failures = 0;
          ctx.reportSuccess?.();
          return c.redirect(`${back}?message=${encodeURIComponent(`Connected to Tautulli: ${sessions.length} active stream(s).`)}`);
        } catch (err) {
          lastError = errorMessage(err);
          log.warn(`Connection test failed: ${lastError}`);
          return c.redirect(`${back}?error=${encodeURIComponent(lastError)}`);
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

    live() {
      const activity = last?.activity;
      const verb = activity?.kind === 'listening' ? 'Listening to' : 'Watching';
      return <>
        <section class="card flush">
          <div class="card-header"><h2>Publishing</h2><span class="small muted">to the Hub</span></div>
          <div class="card-body">
            {activity ? <div class="activity-preview">
              <div class="activity-art">{activity.largeImage ? <img src={activity.largeImage.url} alt="" /> : <Icon name={activity.kind === 'listening' ? 'music' : 'film'} size={28} />}</div>
              <div><div class="small activity-kind">{verb} {activity.name}</div><strong>{activity.title}</strong>{activity.subtitle && <div>{activity.subtitle}</div>}<div class="small muted">Artwork from {last?.artwork?.source ?? 'none'}</div></div>
            </div> : <p class="muted">{last ? 'Nothing playing right now.' : 'Waiting for the first check.'}</p>}
          </div>
        </section>
        <section class="card flush">
          <div class="card-header"><h2>Streams</h2><span class="small muted">{lastSuccessAt ? `checked ${timeAgo(lastSuccessAt)}` : 'not checked yet'}</span></div>
          <div class="card-body">
            {last?.sessions.length ? <div class="stream-list">{last.sessions.map((stream) => <div class="stream-row">
              <span class={stream.state === 'paused' ? 'muted' : 'text-success'}><Icon name={stream.state === 'paused' ? 'pause' : 'play'} size={15} /></span>
              <div><strong>{stream.full_title ?? stream.title}</strong><div class="small muted">{stream.friendly_name ?? stream.user} on {stream.player ?? 'a player'}</div></div>
              <span class={`status-pill ${stream === last!.chosen ? 'health-ok' : ''}`}>{stream === last!.chosen ? 'Shown' : last!.matched.includes(stream) ? 'Matched' : 'Filtered'}</span>
            </div>)}</div> : <p class="muted">No active streams.</p>}
            <p class="help">Streams from other users or players are listed as filtered.</p>
          </div>
        </section>
      </>;
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
