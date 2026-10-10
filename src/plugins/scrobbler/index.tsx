import type { Hono } from 'hono';
import { z } from 'zod';
import type { NowPlaying } from '../../core/activity.js';
import { errorMessage } from '../../core/log.js';
import { defineSource, type SourceContext } from '../../core/plugin.js';
import { timeAgo } from '../../web/layout.js';
import { ArtworkResolver, type Artwork } from './artwork.js';
import { LastfmClient, ListenBrainzClient, ScrobblerError, type Scrobble, type ScrobbleClient } from './client.js';
import { PlayTracker, playTiming, toNowPlaying, trackKey, trackLink, type Timing } from './track.js';

const VARS_HELP = 'Variables: {track} {artist} {album}. Text in [brackets] is dropped if a variable inside is empty.';

const configSchema = z.object({
  service: z
    .enum(['Last.fm', 'ListenBrainz'])
    .default('Last.fm')
    .meta({ title: 'Service', description: 'Where your player scrobbles to.' }),
  username: z.string().trim().default('').meta({ title: 'Username', description: 'Your Last.fm or ListenBrainz username.' }),
  apiKey: z
    .string()
    .trim()
    .default('')
    .meta({
      title: 'Last.fm API key',
      description: 'Last.fm only. Create one at last.fm/api/account/create (any name; the callback URL can stay empty).',
      secret: true,
    }),
  token: z
    .string()
    .trim()
    .default('')
    .meta({
      title: 'ListenBrainz user token (optional)',
      description: 'ListenBrainz only; not needed to read public listens. Sent with each request if set (listenbrainz.org → Settings).',
      secret: true,
    }),
  pollSeconds: z
    .number()
    .int()
    .min(10)
    .max(300)
    .default(15)
    .meta({ title: 'Poll interval (seconds)', description: 'How often to ask what is playing.' }),
  activityName: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Activity name', description: 'Shown as "Listening to <name>". Leave empty for "Last.fm" or "ListenBrainz".' }),
  titleTemplate: z.string().default('{track}').meta({ title: 'First line', description: VARS_HELP }),
  subtitleTemplate: z.string().default('{artist}').meta({ title: 'Second line', description: '' }),
  progressBar: z
    .boolean()
    .default(true)
    .meta({
      title: 'Progress bar',
      description:
        "When the track's length is known and the track started while this app was watching. Neither service says when a track started, so it's timed from when it was first seen (up to one poll interval late). On Last.fm this costs one extra request per track.",
    }),
  maxMinutes: z
    .number()
    .int()
    .min(0)
    .max(600)
    .default(15)
    .meta({
      title: 'Hide after (minutes)',
      description:
        "Both services can keep reporting a track after you stop playing. A track is hidden 2 minutes after its length has passed; if its length isn't known, after this many minutes. 0 = never.",
    }),
  albumArt: z
    .boolean()
    .default(true)
    .meta({ title: 'Album art from iTunes/Deezer', description: 'Look up album covers in the iTunes and Deezer catalogues (no key needed) when the service has none.' }),
  fallbackImage: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Fallback image', description: 'HTTPS URL or Discord app asset key used when no artwork is found.' }),
  smallImage: z
    .string()
    .trim()
    .default('')
    .meta({ title: 'Small image', description: 'Badge in the corner of the artwork: a square HTTPS image URL or a Discord app asset key.' }),
  links: z
    .boolean()
    .default(true)
    .meta({ title: 'Track button', description: 'Add a button linking to the track on Last.fm, or on MusicBrainz for ListenBrainz tracks with a recording id.' }),
});

type Config = z.infer<typeof configSchema>;

interface PollResult {
  at: number;
  track?: Scrobble;
  timing?: Timing;
  durationMs?: number;
  activity?: NowPlaying;
  artwork?: Artwork;
}

/** Give up showing the last activity after this many failed polls in a row. */
const MAX_FAILURES = 3;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

export function createScrobblerPlugin(fetchImpl: typeof fetch = fetch) {
  function createScrobbler(ctx: SourceContext<Config>) {
    const { config, log } = ctx;
    const service = config.service;
    const name = config.activityName || service;
    const lastfm = service === 'Last.fm' ? new LastfmClient(config.username, config.apiKey, fetchImpl) : undefined;
    const listenbrainz = service === 'ListenBrainz' ? new ListenBrainzClient(config.username, config.token, fetchImpl) : undefined;
    const client: ScrobbleClient = (lastfm ?? listenbrainz)!;
    const configured = !!config.username && (service !== 'Last.fm' || !!config.apiKey);
    const resolver = new ArtworkResolver({ log, albumArt: config.albumArt, fallback: config.fallbackImage || undefined, fetchImpl });
    const tracker = new PlayTracker();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: PollResult | undefined;
    let lastError: string | undefined;
    let failures = 0;

    async function poll(): Promise<void> {
      const at = Date.now();
      const track = await client.nowPlaying();
      const result: PollResult = { at };
      const seen = tracker.update(track && trackKey(service, track), at);
      if (track && seen) {
        result.track = track;
        let durationMs = track.durationMs;
        if (durationMs === undefined && lastfm && config.progressBar) durationMs = await lastfm.trackLength(track.artist, track.track);
        result.durationMs = durationMs;
        const timing = playTiming(seen, durationMs, at, { progressBar: config.progressBar, maxMs: config.maxMinutes * 60_000 });
        result.timing = timing;
        if (!timing.stale) {
          const activity = toNowPlaying(service, track, { name, ...config });
          activity.startedAt = timing.startedAt;
          if (timing.endsAt) activity.endsAt = timing.endsAt;
          const artwork = await resolver.resolve(track);
          if (artwork.url) activity.largeImage = { url: artwork.url, ...(track.album && { text: track.album }) };
          if (config.smallImage) activity.smallImage = { url: config.smallImage, text: name };
          const link = config.links ? trackLink(track) : undefined;
          if (link) activity.links = [link];
          result.activity = activity;
          result.artwork = artwork;
        }
      }
      if (ctx.signal.aborted) return;
      last = result;
      ctx.publish(result.activity ?? null);
    }

    async function loop(): Promise<void> {
      let delay = config.pollSeconds * 1000;
      try {
        await poll();
        if (lastError) log.info(`${service} is reachable again`);
        lastError = undefined;
        failures = 0;
      } catch (err) {
        tracker.blind();
        const msg = errorMessage(err);
        if (msg !== lastError) log.error(msg);
        lastError = msg;
        if (++failures >= MAX_FAILURES) ctx.publish(null);
        // Rate limited: wait as long as asked, or back off.
        if (err instanceof ScrobblerError && err.rateLimited) delay = err.retryAfterMs ?? Math.min(delay * 2 ** failures, MAX_BACKOFF_MS);
      }
      delay = Math.max(delay, client.waitMs());
      if (!ctx.signal.aborted) timer = setTimeout(() => void loop(), delay);
    }

    const describe = (s: Scrobble) => `${s.track} by ${s.artist}`;

    return {
      start() {
        if (configured) void loop();
      },
      stop() {
        clearTimeout(timer);
      },
      status() {
        if (!configured) {
          return { health: 'setup' as const, message: service === 'Last.fm' ? 'Set your Last.fm username and API key' : 'Set your ListenBrainz username' };
        }
        if (lastError) return { health: 'error' as const, message: lastError };
        if (!last) return { health: 'idle' as const, message: 'Connecting…' };
        if (last.activity && last.track) {
          return { health: 'ok' as const, message: `Playing ${describe(last.track)}${last.track.player ? ` (${last.track.player})` : ''}` };
        }
        if (last.track) return { health: 'idle' as const, message: `Nothing playing (${describe(last.track)} is still reported, but should have ended)` };
        return { health: 'idle' as const, message: 'Nothing playing' };
      },

      routes(app: Hono) {
        app.post('/test', async (c) => {
          const back = `/instances/${ctx.instanceId}`;
          const fail = (msg: string) => c.redirect(`${back}?error=${encodeURIComponent(msg)}`);
          if (!configured) return fail(service === 'Last.fm' ? 'Set the username and API key first.' : 'Set the username first.');
          try {
            if (listenbrainz && config.token) {
              const t = await listenbrainz.validateToken();
              if (!t.valid) return fail('ListenBrainz rejected the token.');
            }
            const track = await client.nowPlaying();
            const now = track ? `now playing ${describe(track)}` : 'nothing playing right now';
            return c.redirect(`${back}?message=${encodeURIComponent(`Connected to ${service}: ${now}.`)}`);
          } catch (err) {
            return fail(errorMessage(err));
          }
        });
      },

      panel() {
        return (
          <div class="card actions">
            <form class="inline" method="post" action={`${ctx.routeBase}/test`}>
              <button class="secondary">Test connection</button>
            </form>
          </div>
        );
      },

      live() {
        if (!last) return null;
        const { track, timing, activity } = last;
        const minutes = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
        return (
          <div class="card">
            <h2>Now playing</h2>
            <p class="small muted">Last checked {timeAgo(last.at)}.</p>
            {track && timing ? (
              <table>
                <tbody>
                  <tr>
                    <th>Track</th>
                    <td>{describe(track)}</td>
                  </tr>
                  {track.album && (
                    <tr>
                      <th>Album</th>
                      <td>{track.album}</td>
                    </tr>
                  )}
                  {track.player && (
                    <tr>
                      <th>Player</th>
                      <td>{track.player}</td>
                    </tr>
                  )}
                  <tr>
                    <th>First seen</th>
                    <td>{timeAgo(timing.startedAt, last.at)}</td>
                  </tr>
                  <tr>
                    <th>Length</th>
                    <td>{last.durationMs ? minutes(last.durationMs) : 'unknown'}</td>
                  </tr>
                  <tr>
                    <th>Shown</th>
                    <td>
                      {timing.stale
                        ? 'no: reported for longer than it should have played'
                        : timing.hideAt
                          ? `until ${new Date(timing.hideAt).toLocaleTimeString()} unless another track starts`
                          : 'yes'}
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p class="muted">Nothing playing.</p>
            )}
            {activity && (
              <>
                <h2 style="margin-top: 1rem">Published activity</h2>
                <div class="preview">
                  {activity.largeImage && <img src={activity.largeImage.url} alt="" />}
                  <div>
                    <div><strong>{activity.title}</strong></div>
                    {activity.subtitle && <div>{activity.subtitle}</div>}
                    <div class="small muted">
                      Artwork: {last.artwork?.source ?? 'none'} · Progress bar: {activity.endsAt ? 'yes' : 'no'}
                    </div>
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
    id: 'scrobbler',
    name: 'Last.fm / ListenBrainz',
    description: 'What you are scrobbling right now, from anything that scrobbles to Last.fm or ListenBrainz.',
    configSchema,
    multiple: true,
    create: createScrobbler,
  });
}

export const scrobblerPlugin = createScrobblerPlugin();
