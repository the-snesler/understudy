import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { emptyConfig, Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore } from '../src/core/store.js';
import { ArtworkResolver, coverArtUrl } from '../src/plugins/scrobbler/artwork.js';
import { LastfmClient, ListenBrainzClient, type LastfmTrack, type Scrobble } from '../src/plugins/scrobbler/client.js';
import { createScrobblerPlugin } from '../src/plugins/scrobbler/index.js';
import { GRACE_MS, PlayTracker, playTiming, toNowPlaying, trackKey, trackLink } from '../src/plugins/scrobbler/track.js';
import { createWebApp } from '../src/web/app.js';
import { quietLogger, scriptedFetch } from './helpers.js';

const RELEASE = '76df3287-6cda-33eb-8e9a-044b5e15ffdd';
const RECORDING = 'a1b2c3d4-0000-4000-8000-000000000001';
const PLACEHOLDER = 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';

const lastfmPlaying: LastfmTrack = {
  name: 'Windowlicker',
  mbid: RECORDING,
  url: 'https://www.last.fm/music/Aphex+Twin/_/Windowlicker',
  artist: { mbid: '', '#text': 'Aphex Twin' },
  album: { mbid: RELEASE, '#text': 'Windowlicker' },
  image: [
    { size: 'small', '#text': 'https://lastfm.freetls.fastly.net/i/u/34s/abc.png' },
    { size: 'extralarge', '#text': 'https://lastfm.freetls.fastly.net/i/u/300x300/abc.png' },
    { size: 'large', '#text': 'https://lastfm.freetls.fastly.net/i/u/174s/abc.png' },
  ],
  '@attr': { nowplaying: 'true' },
};

const lastfmScrobbled: LastfmTrack = {
  name: 'Flim',
  artist: { mbid: '', '#text': 'Aphex Twin' },
  album: { mbid: '', '#text': 'Come to Daddy' },
  image: [{ size: 'extralarge', '#text': PLACEHOLDER }],
  date: { uts: '1700000000' },
};

const recent = (...tracks: LastfmTrack[]) => ({ recenttracks: { track: tracks.length === 1 ? tracks[0] : tracks, '@attr': { user: 'tsuni' } } });

const listen = (extra: Record<string, unknown> = {}) => ({
  payload: {
    count: 1,
    playing_now: true,
    user_id: 'tsuni',
    listens: [
      {
        playing_now: true,
        track_metadata: {
          track_name: 'Shelter',
          artist_name: 'Porter Robinson & Madeon',
          release_name: 'Shelter',
          additional_info: { duration_ms: 219_000, release_mbid: RELEASE, recording_mbid: RECORDING, media_player: 'Plexamp', ...extra },
        },
      },
    ],
  },
});

const song: Scrobble = { track: 'Shelter', artist: 'Porter Robinson & Madeon', album: 'Shelter' };

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetch that answers by URL, recording each request's method, URL and headers. */
function routedFetch(route: (url: URL) => Reply) {
  const calls: { method: string; url: URL; headers: Headers }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? 'GET', url, headers: new Headers(init?.headers) });
    const r = route(url);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { impl, calls };
}

describe('Last.fm client', () => {
  it('finds the now-playing track next to the last scrobble, using the largest real image', async () => {
    const fetch = scriptedFetch([{ status: 200, body: recent(lastfmPlaying, lastfmScrobbled) }]);
    const s = await new LastfmClient('tsuni', 'k', fetch.impl).nowPlaying();
    expect(s).toEqual({
      track: 'Windowlicker',
      artist: 'Aphex Twin',
      album: 'Windowlicker',
      recordingMbid: RECORDING,
      releaseMbid: RELEASE,
      image: 'https://lastfm.freetls.fastly.net/i/u/300x300/abc.png',
      url: 'https://www.last.fm/music/Aphex+Twin/_/Windowlicker',
    });
    const url = new URL(fetch.calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ method: 'user.getrecenttracks', user: 'tsuni', limit: '1', api_key: 'k', format: 'json' });
  });

  it('reports nothing for a lone scrobbled track, and treats the star placeholder as no image', async () => {
    const fetch = scriptedFetch([
      { status: 200, body: recent(lastfmScrobbled) },
      { status: 200, body: recent({ ...lastfmScrobbled, '@attr': { nowplaying: 'true' } }) },
      { status: 200, body: { recenttracks: { track: [] } } },
    ]);
    const client = new LastfmClient('tsuni', 'k', fetch.impl);
    expect(await client.nowPlaying()).toBeUndefined();
    const s = await client.nowPlaying();
    expect(s).toEqual({ track: 'Flim', artist: 'Aphex Twin', album: 'Come to Daddy' });
    expect(await client.nowPlaying()).toBeUndefined();
  });

  it('turns error JSON into errors, whatever the HTTP status, without leaking the key', async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { error: 10, message: 'Invalid API key - You must be granted a valid key by last.fm' } },
      { status: 403, body: { error: 26, message: 'Suspended API key' } },
      { status: 200, body: { error: 29, message: 'Rate limit exceeded' } },
      { status: 200, body: { error: 17, message: 'Login: User required to be logged in' } },
      { status: 404, body: { error: 6, message: 'User not found' } },
      { status: 502, body: undefined },
    ]);
    const client = new LastfmClient('tsuni', 'secret-key', fetch.impl);
    const errors: { message: string; rateLimited: boolean }[] = [];
    for (let i = 0; i < 6; i++) errors.push(await client.nowPlaying().then(() => ({ message: 'ok', rateLimited: false }), (e) => e));
    expect(errors.map((e) => e.message)).toEqual([
      'Last.fm rejected the API key',
      'Last.fm rejected the API key',
      'Last.fm rate limit exceeded',
      'Last.fm user "tsuni" hides their recent listening (Last.fm → Settings → Privacy)',
      'Last.fm user.getrecenttracks failed: User not found',
      'Last.fm user.getrecenttracks failed (502)',
    ]);
    expect(errors.map((e) => e.rateLimited)).toEqual([false, false, true, false, false, false]);
    expect(JSON.stringify(errors.map((e) => e.message))).not.toContain('secret-key');
  });

  it('looks up track lengths once per track, treating 0 and not-found as unknown', async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { track: { name: 'Windowlicker', duration: '366000' } } },
      { status: 200, body: { track: { name: 'Flim', duration: '0' } } },
      { status: 200, body: { error: 6, message: 'Track not found' } },
    ]);
    const client = new LastfmClient('tsuni', 'k', fetch.impl);
    expect(await client.trackLength('Aphex Twin', 'Windowlicker')).toBe(366_000);
    expect(await client.trackLength('aphex twin', 'WINDOWLICKER')).toBe(366_000);
    expect(await client.trackLength('Aphex Twin', 'Flim')).toBeUndefined();
    expect(await client.trackLength('Nobody', 'Nothing')).toBeUndefined();
    expect(await client.trackLength('Nobody', 'Nothing')).toBeUndefined();
    expect(fetch.calls).toHaveLength(3);
    expect(new URL(fetch.calls[0]!.url).searchParams.get('method')).toBe('track.getInfo');
  });
});

describe('ListenBrainz client', () => {
  it('maps playing-now with duration, ids and player, and sends the token', async () => {
    const fetch = routedFetch(() => ({ status: 200, body: listen(), headers: { 'X-RateLimit-Remaining': '29', 'X-RateLimit-Reset-In': '5' } }));
    const client = new ListenBrainzClient('ts uni', 'tok', fetch.impl);
    expect(await client.nowPlaying()).toEqual({
      track: 'Shelter',
      artist: 'Porter Robinson & Madeon',
      album: 'Shelter',
      durationMs: 219_000,
      recordingMbid: RECORDING,
      releaseMbid: RELEASE,
      player: 'Plexamp',
    });
    expect(fetch.calls[0]!.url.toString()).toBe('https://api.listenbrainz.org/1/user/ts%20uni/playing-now');
    expect(fetch.calls[0]!.headers.get('authorization')).toBe('Token tok');
    expect(client.waitMs()).toBe(0);
  });

  it('accepts a duration in seconds, ignores malformed MBIDs, and omits the token when unset', async () => {
    const fetch = routedFetch(() => ({ status: 200, body: listen({ duration_ms: undefined, duration: 200, release_mbid: '../../evil', recording_mbid: undefined }) }));
    const client = new ListenBrainzClient('tsuni', '', fetch.impl);
    const s = await client.nowPlaying();
    expect(s).toMatchObject({ durationMs: 200_000 });
    expect(s?.releaseMbid).toBeUndefined();
    expect(fetch.calls[0]!.headers.has('authorization')).toBe(false);
  });

  it('reports nothing playing, unknown users and rate limits', async () => {
    let next: Reply = {
      status: 200,
      body: { payload: { count: 0, listens: [], playing_now: true } },
      headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-In': '7' },
    };
    const client = new ListenBrainzClient('tsuni', '', routedFetch(() => next).impl);
    expect(await client.nowPlaying()).toBeUndefined();
    // The window is used up: wait until it resets.
    expect(client.waitMs()).toBeGreaterThan(6_000);

    next = { status: 429, body: { code: 429, error: 'Too many requests' }, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-In': '3' } };
    await expect(client.nowPlaying()).rejects.toMatchObject({ rateLimited: true, retryAfterMs: 3_000, message: 'ListenBrainz rate limit exceeded' });

    next = { status: 404, body: { code: 404, error: 'Cannot find user: tsuni' } };
    await expect(client.nowPlaying()).rejects.toThrow('ListenBrainz user "tsuni" not found');
  });
});

describe('artwork', () => {
  it('follows Cover Art Archive redirects to the final https URL', async () => {
    const fetch = scriptedFetch([
      { status: 307, headers: { Location: `https://archive.org/download/mbid-${RELEASE}/mbid-${RELEASE}-1_thumb500.jpg` } },
      { status: 302, headers: { Location: `https://dn7.ca.archive.org/0/items/mbid-${RELEASE}/mbid-${RELEASE}-1_thumb500.jpg` } },
      { status: 200 },
    ]);
    expect(await coverArtUrl(fetch.impl, 'release', RELEASE)).toBe(`https://dn7.ca.archive.org/0/items/mbid-${RELEASE}/mbid-${RELEASE}-1_thumb500.jpg`);
    expect(fetch.calls.map((c) => c.method)).toEqual(['HEAD', 'HEAD', 'HEAD']);
    expect(fetch.calls[0]!.url).toBe(`https://coverartarchive.org/release/${RELEASE}/front-500`);

    const none = scriptedFetch([{ status: 404 }]);
    expect(await coverArtUrl(none.impl, 'release', RELEASE)).toBeUndefined();
    const insecure = scriptedFetch([{ status: 307, headers: { Location: 'http://archive.org/x.jpg' } }]);
    expect(await coverArtUrl(insecure.impl, 'release', RELEASE)).toBeUndefined();
  });

  it("uses the service's image first, then the Cover Art Archive, then iTunes", async () => {
    const fetch = scriptedFetch([
      { status: 404 }, // no cover for the release
      { status: 302, headers: { Location: 'https://archive.org/group.jpg' } },
      { status: 200 },
      { status: 200, body: { results: [{ collectionName: 'Shelter - Single', artistName: 'Porter Robinson & Madeon', artworkUrl100: 'https://x/s/100x100bb.jpg' }] } },
    ]);
    const r = new ArtworkResolver({ log: quietLogger(), albumArt: true, fetchImpl: fetch.impl });
    expect(await r.resolve({ ...song, image: 'https://lastfm/x.png' })).toEqual({ url: 'https://lastfm/x.png', source: 'lastfm' });
    expect(await r.resolve({ ...song, releaseMbid: RELEASE, releaseGroupMbid: RECORDING })).toEqual({ url: 'https://archive.org/group.jpg', source: 'coverartarchive' });
    expect(await r.resolve(song)).toEqual({ url: 'https://x/s/600x600bb.jpg', source: 'itunes' });
    // Cached per album.
    await r.resolve({ ...song, track: 'Another track' });
    expect(fetch.calls).toHaveLength(4);
  });

  it('falls back when nothing is found or the archive is down', async () => {
    const fetch = scriptedFetch([{ status: 503 }, { status: 404 }]);
    const r = new ArtworkResolver({ log: quietLogger(), albumArt: false, fallback: 'music', fetchImpl: fetch.impl });
    expect(await r.resolve({ ...song, releaseMbid: RELEASE })).toEqual({ url: 'music', source: 'fallback' });
    expect(await r.resolve(song)).toEqual({ url: 'music', source: 'fallback' });
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('track mapping and timing', () => {
  it('renders templates, with a stable key and a track link', () => {
    const a = toNowPlaying('ListenBrainz', song, { name: 'ListenBrainz', titleTemplate: '{track}', subtitleTemplate: '[by {artist}][ · {album}]' });
    expect(a).toEqual({
      key: 'listenbrainz:porter robinson & madeon|shelter|shelter',
      kind: 'listening',
      name: 'ListenBrainz',
      title: 'Shelter',
      subtitle: 'by Porter Robinson & Madeon · Shelter',
    });
    expect(trackKey('Last.fm', { ...song, track: 'SHELTER' })).toBe('lastfm:porter robinson & madeon|shelter|shelter');
    expect(trackLink({ ...song, url: 'https://www.last.fm/x', recordingMbid: RECORDING })).toEqual({ label: 'Last.fm', url: 'https://www.last.fm/x' });
    expect(trackLink({ ...song, recordingMbid: RECORDING })).toEqual({ label: 'MusicBrainz', url: `https://musicbrainz.org/recording/${RECORDING}` });
    expect(trackLink(song)).toBeUndefined();
  });

  it('keeps the first-seen time, and only shows a bar for tracks it saw start', () => {
    const t = new PlayTracker();
    const opts = { progressBar: true, maxMs: 15 * 60_000 };
    // Already playing when we started watching: no bar, since we don't know how far in it is.
    const first = t.update('a', 1_000)!;
    expect(playTiming(first, 200_000, 1_000, opts)).toEqual({ startedAt: 1_000, hideAt: 1_000 + 200_000 + GRACE_MS, stale: false });
    expect(t.update('a', 16_000)).toBe(first);
    // The next track started between two polls: bar.
    const second = t.update('b', 31_000)!;
    expect(playTiming(second, 200_000, 31_000, opts)).toMatchObject({ startedAt: 31_000, endsAt: 231_000, stale: false });
    expect(playTiming(second, 200_000, 31_000, { ...opts, progressBar: false }).endsAt).toBeUndefined();
    // Past the end: no bar; past the grace period: hidden.
    expect(playTiming(second, 200_000, 240_000, opts)).toEqual({ startedAt: 31_000, hideAt: 231_000 + GRACE_MS, stale: false });
    expect(playTiming(second, 200_000, 231_000 + GRACE_MS, opts).stale).toBe(true);
    // Unknown length: the cap, or never.
    expect(playTiming(second, undefined, 31_000 + 15 * 60_000, opts)).toEqual({ startedAt: 31_000, hideAt: 31_000 + 15 * 60_000, stale: true });
    expect(playTiming(second, undefined, 31_000 + 15 * 60_000, { ...opts, maxMs: 0 })).toEqual({ startedAt: 31_000, stale: false });
  });

  it("doesn't claim to have seen a start after nothing, or after a failed poll", () => {
    const t = new PlayTracker();
    t.update(undefined, 0);
    expect(t.update('a', 15_000)).toEqual({ key: 'a', since: 15_000, sawStart: true });
    t.blind();
    expect(t.update('a', 30_000)?.since).toBe(15_000);
    t.blind();
    expect(t.update('b', 45_000)).toEqual({ key: 'b', since: 45_000, sawStart: false });
  });
});

// ---- plugin end to end, against fake services ------------------------------------------------------

const dirs: string[] = [];
const registries: Registry[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const r of registries.splice(0)) await r.stopAll();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function boot(fetchImpl: typeof fetch, config: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srpc-scrobbler-'));
  dirs.push(dir);
  const hub = new Hub();
  const logs = new LogBuffer();
  const registry = new Registry({
    plugins: [createScrobblerPlugin(fetchImpl)],
    config: new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig),
    state: new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({})),
    hub,
    log: new Logger(logs, 'test', 'error'),
    env: { publicUrl: undefined },
  });
  registries.push(registry);
  await registry.ensureInstances([{ plugin: 'scrobbler', enabled: true }]);
  expect((await registry.saveConfig('scrobbler', config)).ok).toBe(true);
  const app = createWebApp({ registry, hub, logs, env: { publicUrl: undefined }, uiPassword: undefined });
  const post = (p: string) => app.request(p, { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' } });
  const live = async () => (await app.request('/instances/scrobbler/live')).text();
  return { hub, registry, post, live, status: () => registry.get('scrobbler')!.status, activity: () => hub.get('scrobbler')?.activity };
}

describe('scrobbler plugin', () => {
  it('shows a Last.fm track with a bar once it sees it start, and hides it when it lingers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let playing: LastfmTrack[] = [lastfmScrobbled];
    const fetch = routedFetch((url) => {
      const method = url.searchParams.get('method');
      if (method === 'user.getrecenttracks') return { status: 200, body: recent(...playing) };
      if (method === 'track.getInfo') return { status: 200, body: { track: { duration: '240000' } } };
      return { status: 500 };
    });
    const t = await boot(fetch.impl, { username: 'tsuni', apiKey: 'k', smallImage: 'lastfm' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.status()).toEqual({ health: 'idle', message: 'Nothing playing' });

    playing = [lastfmPlaying, lastfmScrobbled];
    await vi.advanceTimersByTimeAsync(15_000);
    const seenAt = Date.now();
    expect(t.activity()).toEqual({
      key: 'lastfm:aphex twin|windowlicker|windowlicker',
      kind: 'listening',
      name: 'Last.fm',
      title: 'Windowlicker',
      subtitle: 'by Aphex Twin',
      largeImage: { url: 'https://lastfm.freetls.fastly.net/i/u/300x300/abc.png', text: 'Windowlicker' },
      smallImage: { url: 'lastfm', text: 'Last.fm' },
      startedAt: seenAt,
      endsAt: seenAt + 240_000,
      links: [{ label: 'Last.fm', url: 'https://www.last.fm/music/Aphex+Twin/_/Windowlicker' }],
    });
    expect(t.status()).toEqual({ health: 'ok', message: 'Playing Windowlicker by Aphex Twin' });

    // Still reported on later polls: the same start.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.activity()?.startedAt).toBe(seenAt);
    // Paused or stopped, but Last.fm still says now playing: hidden after length + grace.
    await vi.advanceTimersByTimeAsync(240_000 + GRACE_MS);
    expect(t.activity()).toBeUndefined();
    expect(t.status().message).toBe('Nothing playing (Windowlicker by Aphex Twin is still reported, but should have ended)');
    expect(fetch.calls.filter((c) => c.url.searchParams.get('method') === 'track.getInfo')).toHaveLength(1);
  });

  it('shows a ListenBrainz track with Cover Art Archive art and a MusicBrainz link', async () => {
    const fetch = routedFetch((url): Reply => {
      if (url.hostname === 'api.listenbrainz.org') return { status: 200, body: listen(), headers: { 'X-RateLimit-Remaining': '20', 'X-RateLimit-Reset-In': '5' } };
      if (url.hostname === 'coverartarchive.org') return { status: 307, headers: { Location: 'https://archive.org/download/cover.jpg' } };
      if (url.hostname === 'archive.org') return { status: 200 };
      return { status: 500 };
    });
    const t = await boot(fetch.impl, { service: 'ListenBrainz', username: 'tsuni', activityName: 'Music' });
    await vi.waitFor(() => expect(t.activity()).toBeDefined());
    expect(t.activity()).toMatchObject({
      name: 'Music',
      title: 'Shelter',
      largeImage: { url: 'https://archive.org/download/cover.jpg', text: 'Shelter' },
      links: [{ label: 'MusicBrainz', url: `https://musicbrainz.org/recording/${RECORDING}` }],
    });
    // Already playing when we started: no progress bar.
    expect(t.activity()?.endsAt).toBeUndefined();
    expect(t.status()).toEqual({ health: 'ok', message: 'Playing Shelter by Porter Robinson & Madeon (Plexamp)' });
    const live = await t.live();
    expect(live).toContain('Plexamp');
    expect(live).toContain('3:39');
    expect(live).toContain('Artwork: coverartarchive');
  });

  it('backs off when Last.fm rate limits, and clears after repeated failures', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let limited = false;
    const fetch = routedFetch((url) => {
      if (limited) return { status: 200, body: { error: 29, message: 'Rate limit exceeded' } };
      if (url.searchParams.get('method') === 'track.getInfo') return { status: 200, body: { track: { duration: '0' } } };
      return { status: 200, body: recent(lastfmPlaying) };
    });
    const t = await boot(fetch.impl, { username: 'tsuni', apiKey: 'k', pollSeconds: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.activity()).toBeDefined();
    const polls = () => fetch.calls.filter((c) => c.url.searchParams.get('method') === 'user.getrecenttracks').length;

    limited = true;
    await vi.advanceTimersByTimeAsync(10_000); // fails; next try in 20 s
    expect(t.status()).toEqual({ health: 'error', message: 'Last.fm rate limit exceeded' });
    expect(t.activity()).toBeDefined();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000); // fails; next in 40 s
    expect(polls()).toBe(3);
    await vi.advanceTimersByTimeAsync(40_000); // third failure: withdrawn
    expect(polls()).toBe(4);
    expect(t.activity()).toBeUndefined();

    limited = false;
    await vi.advanceTimersByTimeAsync(80_000);
    expect(t.status().health).toBe('ok');
  });

  it('tests the connection, including the ListenBrainz token', async () => {
    const fetch = routedFetch((url) => {
      if (url.pathname === '/1/validate-token') return { status: 200, body: { code: 200, message: 'Token invalid.', valid: false } };
      return { status: 200, body: { payload: { count: 0, listens: [] } } };
    });
    const t = await boot(fetch.impl, { service: 'ListenBrainz', username: 'tsuni', token: 'bad' });
    const res = await t.post('/plugins/scrobbler/test');
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('error=ListenBrainz rejected the token.');

    const ok = routedFetch(() => ({ status: 200, body: { payload: { count: 0, listens: [] } } }));
    const t2 = await boot(ok.impl, { service: 'ListenBrainz', username: 'tsuni' });
    const res2 = await t2.post('/plugins/scrobbler/test');
    expect(decodeURIComponent(res2.headers.get('location') ?? '')).toContain('message=Connected to ListenBrainz: nothing playing right now.');
  });

  it('asks for setup when unconfigured', async () => {
    const t = await boot(routedFetch(() => ({ status: 500 })).impl, {});
    expect(t.status()).toEqual({ health: 'setup', message: 'Set your Last.fm username and API key' });
    const lb = await boot(routedFetch(() => ({ status: 500 })).impl, { service: 'ListenBrainz' });
    expect(lb.status()).toEqual({ health: 'setup', message: 'Set your ListenBrainz username' });
  });
});
