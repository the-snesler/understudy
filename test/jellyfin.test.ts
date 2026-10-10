import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { emptyConfig, Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore } from '../src/core/store.js';
import { ArtworkResolver, parseProviderIds, signItem, verifyItem } from '../src/plugins/jellyfin/artwork.js';
import { JellyfinClient, type JellyfinSession } from '../src/plugins/jellyfin/client.js';
import { jellyfinPlugin } from '../src/plugins/jellyfin/index.js';
import { chooseSession, imageItemId, matchesFilter, toNowPlaying } from '../src/plugins/jellyfin/session.js';
import { quietLogger, scriptedFetch } from './helpers.js';

const templates = jellyfinPlugin.configSchema.parse({}) as unknown as Parameters<typeof toNowPlaying>[1]['templates'];

/** Ticks are 100 ns: 10,000 per millisecond. */
const ticks = (ms: number) => ms * 10_000;

const movieSession: JellyfinSession = {
  Id: 'sess-movie',
  UserId: 'u1',
  UserName: 'tsuni',
  Client: 'Jellyfin Android TV',
  DeviceName: 'Living Room TV',
  LastActivityDate: '2026-10-09T12:00:00Z',
  PlayState: { PositionTicks: ticks(600_000), IsPaused: false },
  NowPlayingItem: {
    Id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    Name: 'The Matrix',
    Type: 'Movie',
    MediaType: 'Video',
    ProductionYear: 1999,
    RunTimeTicks: ticks(8_160_000),
    Genres: ['Science Fiction', 'Action'],
    Studios: [{ Name: 'Warner Bros. Pictures' }],
    ProviderIds: { Imdb: 'tt0133093', Tmdb: '603' },
    ImageTags: { Primary: 'tag' },
  },
};

const episodeSession: JellyfinSession = {
  UserId: 'u1',
  UserName: 'tsuni',
  Client: 'Jellyfin Web',
  DeviceName: 'Firefox',
  LastActivityDate: '2026-10-09T12:05:00Z',
  PlayState: { PositionTicks: ticks(60_000), IsPaused: true },
  NowPlayingItem: {
    Id: 'ep1',
    Name: 'Pilot',
    Type: 'Episode',
    MediaType: 'Video',
    SeriesId: 'series1',
    SeriesName: 'Twin Peaks',
    ParentIndexNumber: 1,
    IndexNumber: 1,
    RunTimeTicks: ticks(5_400_000),
    // The episode's own ids: not the show's.
    ProviderIds: { Tvdb: '1', Imdb: 'tt9999999' },
    SeriesPrimaryImageTag: 'stag',
  },
};

const trackSession: JellyfinSession = {
  UserId: 'u2',
  UserName: 'someone-else',
  Client: 'Finamp',
  DeviceName: 'Phone',
  LastPlaybackCheckIn: '2026-10-09T12:10:00Z',
  PlayState: { PositionTicks: ticks(1000), IsPaused: false },
  NowPlayingItem: {
    Id: '777',
    Name: 'Windowlicker',
    Type: 'Audio',
    MediaType: 'Audio',
    Album: 'Windowlicker',
    AlbumId: '776',
    AlbumArtist: 'Aphex Twin',
    Artists: ['Aphex Twin'],
    RunTimeTicks: ticks(366_000),
    AlbumPrimaryImageTag: 'atag',
  },
};

describe('session mapping', () => {
  it('maps a movie with timestamps from the playback position', () => {
    const a = toNowPlaying(movieSession, { name: 'Jellyfin', templates, now: 10_000_000 });
    expect(a).toEqual({
      key: 'jellyfin:a1b2c3d4e5f60718293a4b5c6d7e8f90',
      kind: 'watching',
      name: 'Jellyfin',
      title: 'The Matrix (1999)',
      subtitle: 'Science Fiction · Warner Bros. Pictures',
      startedAt: 9_400_000,
      endsAt: 9_400_000 + 8_160_000,
    });
  });

  it('maps a paused episode', () => {
    const a = toNowPlaying(episodeSession, { name: 'Emby', templates, now: 1_000_000 });
    expect(a).toMatchObject({ kind: 'watching', name: 'Emby', title: 'Twin Peaks', subtitle: 'S01E01 · Pilot', paused: true });
  });

  it('drops the episode number when there is none', () => {
    const special = { ...episodeSession, NowPlayingItem: { ...episodeSession.NowPlayingItem, ParentIndexNumber: undefined } };
    expect(toNowPlaying(special, { name: 'Jellyfin', templates, now: 0 }).subtitle).toBe('Pilot');
  });

  it('maps a track as listening, and other audio such as audiobooks too', () => {
    expect(toNowPlaying(trackSession, { name: 'Jellyfin', templates, now: 1_000_000 })).toMatchObject({
      kind: 'listening',
      title: 'Windowlicker',
      subtitle: 'by Aphex Twin',
    });
    const book: JellyfinSession = { NowPlayingItem: { Id: 'b', Name: 'Chapter 3', Type: 'AudioBook', MediaType: 'Audio', Album: 'Dune' } };
    expect(toNowPlaying(book, { name: 'Jellyfin', templates, now: 0 })).toMatchObject({ kind: 'listening', title: 'Chapter 3', subtitle: 'Dune' });
    const video: JellyfinSession = { NowPlayingItem: { Id: 'v', Name: 'Around the World', Type: 'MusicVideo', MediaType: 'Video', Artists: ['Daft Punk'] } };
    expect(toNowPlaying(video, { name: 'Jellyfin', templates, now: 0 })).toMatchObject({ kind: 'watching', subtitle: 'by Daft Punk' });
  });

  it('filters by user and by client or device, case-insensitively', () => {
    expect(matchesFilter(movieSession, { users: ['TSUNI'], clients: [] })).toBe(true);
    expect(matchesFilter(movieSession, { users: ['tsuni'], clients: ['living room tv'] })).toBe(true);
    expect(matchesFilter(movieSession, { users: [], clients: ['jellyfin android tv'] })).toBe(true);
    expect(matchesFilter(movieSession, { users: ['tsuni'], clients: ['finamp'] })).toBe(false);
    expect(matchesFilter(trackSession, { users: ['tsuni'], clients: [] })).toBe(false);
    expect(matchesFilter(trackSession, { users: [], clients: [] })).toBe(true);
  });

  it('prefers playing over paused, then the most recent, and skips idle sessions', () => {
    const idle: JellyfinSession = { UserName: 'tsuni', LastActivityDate: '2026-10-09T13:00:00Z' };
    expect(chooseSession([episodeSession, movieSession, idle])?.NowPlayingItem?.Name).toBe('The Matrix');
    expect(chooseSession([movieSession, trackSession])?.NowPlayingItem?.Name).toBe('Windowlicker');
    expect(chooseSession([idle])).toBeUndefined();
    expect(chooseSession([])).toBeUndefined();
  });

  it("picks the show's or album's image for the proxy", () => {
    expect(imageItemId(episodeSession.NowPlayingItem!)).toBe('series1');
    expect(imageItemId(trackSession.NowPlayingItem!)).toBe('776');
    expect(imageItemId(movieSession.NowPlayingItem!)).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
  });
});

describe('client', () => {
  it('authenticates Jellyfin with the MediaBrowser scheme and Emby with X-Emby-Token', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response('[]', { status: 200 });
    }) as typeof fetch;
    await new JellyfinClient('Jellyfin', 'http://jf:8096/', 'k1', fetchImpl).sessions();
    await new JellyfinClient('Emby', 'http://emby:8096', 'k2', fetchImpl).sessions();
    expect(seen[0]!.url).toBe('http://jf:8096/Sessions?activeWithinSeconds=960');
    expect(seen[0]!.headers.get('authorization')).toBe('MediaBrowser Token="k1"');
    expect(seen[0]!.headers.get('x-emby-token')).toBeNull();
    expect(seen[1]!.url).toBe('http://emby:8096/emby/Sessions?activeWithinSeconds=960');
    expect(seen[1]!.headers.get('x-emby-token')).toBe('k2');
    expect(seen[1]!.headers.get('authorization')).toBeNull();
  });

  it('reports a rejected key and a non-API URL', async () => {
    const fetch = scriptedFetch([{ status: 401 }, { status: 200, body: { not: 'sessions' } }]);
    const client = new JellyfinClient('Jellyfin', 'http://jf:8096', 'k', fetch.impl);
    await expect(client.sessions()).rejects.toThrow('Jellyfin rejected the API key');
    await expect(client.sessions()).rejects.toThrow('unexpected response');
  });
});

describe('artwork', () => {
  it('parses provider ids', () => {
    expect(parseProviderIds({ Tmdb: '603', Imdb: 'tt0133093', Tvdb: '169', TmdbCollection: '2344' })).toEqual({
      tmdb: '603',
      imdb: 'tt0133093',
      tvdb: '169',
    });
    expect(parseProviderIds({ imdb: 'tt1' })).toEqual({ imdb: 'tt1' });
    expect(parseProviderIds(undefined)).toEqual({});
  });

  it('signs and verifies proxy tokens, only for item ids', () => {
    const token = signItem('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'secret')!;
    expect(verifyItem(token, 'secret')).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(verifyItem(token, 'other-secret')).toBeUndefined();
    expect(verifyItem(token.replace(/^\w/, 'x'), 'secret')).toBeUndefined();
    expect(verifyItem(signItem('12345', 'secret')!, 'secret')).toBe('12345');
    expect(signItem('../../System/Info', 'secret')).toBeUndefined();
  });

  it('uses the TMDB poster for movies, from the item\'s own ids, with an IMDb link', async () => {
    const fetch = scriptedFetch([{ status: 200, body: { poster_path: '/matrix.jpg' } }]);
    const client = new JellyfinClient('Jellyfin', 'http://jf:8096', 'k', fetch.impl);
    const r = new ArtworkResolver({ client, log: quietLogger(), tmdbKey: 'abc123', albumArt: true, fetchImpl: fetch.impl });
    expect(await r.resolve(movieSession)).toEqual({
      url: 'https://image.tmdb.org/t/p/w500/matrix.jpg',
      source: 'tmdb',
      links: [{ label: 'IMDb', url: 'https://www.imdb.com/title/tt0133093/' }],
    });
    expect(fetch.calls[0]?.url).toBe('https://api.themoviedb.org/3/movie/603?api_key=abc123');
    // Cached: no more requests.
    await r.resolve(movieSession);
    expect(fetch.calls).toHaveLength(1);
  });

  it("looks up the show's ids for episodes, once per show", async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { Items: [{ Id: 'series1', ProviderIds: { Tvdb: '70533' } }] } },
      { status: 200, body: { tv_results: [{ poster_path: '/tp.jpg' }] } },
      { status: 200, body: { tv_results: [{ poster_path: '/tp.jpg' }] } },
    ]);
    const client = new JellyfinClient('Jellyfin', 'http://jf:8096', 'k', fetch.impl);
    const r = new ArtworkResolver({ client, log: quietLogger(), tmdbKey: 'eyJhbGciOi.token', albumArt: true, fetchImpl: fetch.impl });
    expect((await r.resolve(episodeSession)).url).toBe('https://image.tmdb.org/t/p/w500/tp.jpg');
    expect(fetch.calls[0]?.url).toBe('http://jf:8096/Items?Ids=series1&Fields=ProviderIds&UserId=u1');
    expect(fetch.calls[1]?.url).toBe('https://api.themoviedb.org/3/find/70533?external_source=tvdb_id');
    const next = { ...episodeSession, NowPlayingItem: { ...episodeSession.NowPlayingItem, Id: 'ep2', Name: 'Traces to Nowhere' } };
    await r.resolve(next);
    expect(fetch.calls.map((c) => c.url).filter((u) => u.includes('/Items'))).toHaveLength(1);
  });

  it('uses iTunes for album art', async () => {
    const fetch = scriptedFetch([
      {
        status: 200,
        body: { results: [{ collectionName: 'Windowlicker - EP', artistName: 'Aphex Twin', artworkUrl100: 'https://is1.mzstatic.com/b/100x100bb.jpg' }] },
      },
    ]);
    const client = new JellyfinClient('Jellyfin', 'http://jf:8096', 'k', fetch.impl);
    const r = new ArtworkResolver({ client, log: quietLogger(), albumArt: true, fetchImpl: fetch.impl });
    expect(await r.resolve(trackSession)).toMatchObject({ source: 'itunes', url: 'https://is1.mzstatic.com/b/600x600bb.jpg' });
  });

  it('falls back to the proxy, then the fallback image, when lookups find nothing or fail', async () => {
    const fetch = scriptedFetch([{ status: 500, body: {} }]);
    const client = new JellyfinClient('Jellyfin', 'http://jf:8096', 'k', fetch.impl);
    const proxied = new ArtworkResolver({
      client,
      log: quietLogger(),
      albumArt: false,
      proxyUrl: (id) => `https://rpc.example/art/${id}`,
      fetchImpl: fetch.impl,
    });
    // The series lookup fails: still the show's image through the proxy.
    expect(await proxied.resolve(episodeSession)).toMatchObject({ source: 'proxy', url: 'https://rpc.example/art/series1' });

    const fallback = new ArtworkResolver({ client, log: quietLogger(), albumArt: false, fallback: 'jellyfin', fetchImpl: fetch.impl });
    expect(await fallback.resolve(trackSession)).toMatchObject({ source: 'fallback', url: 'jellyfin' });
  });
});

// ---- plugin end to end, against a fake Jellyfin/Emby ------------------------------------------

const dirs: string[] = [];
const servers: http.Server[] = [];
const registries: Registry[] = [];
afterEach(async () => {
  for (const r of registries.splice(0)) await r.stopAll();
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function fakeServer(type: 'Jellyfin' | 'Emby', sessions: () => JellyfinSession[]) {
  const seen: URL[] = [];
  const prefix = type === 'Emby' ? '/emby' : '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(url);
    const token = type === 'Emby' ? req.headers['x-emby-token'] : /Token="([^"]*)"/.exec(req.headers.authorization ?? '')?.[1];
    if (token !== 'good-key') {
      res.statusCode = 401;
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === `${prefix}/Sessions`) res.end(JSON.stringify(sessions()));
    else if (url.pathname === `${prefix}/Items`) res.end(JSON.stringify({ Items: [{ ProviderIds: { Imdb: 'tt0098936' } }] }));
    else if (url.pathname.startsWith(`${prefix}/Items/`) && url.pathname.endsWith('/Images/Primary')) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.end(`JPEG:${url.pathname}`);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function boot(config: Record<string, unknown>, publicUrl?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srpc-jellyfin-'));
  dirs.push(dir);
  const hub = new Hub();
  const registry = new Registry({
    plugins: [jellyfinPlugin],
    config: new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig),
    state: new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({})),
    hub,
    log: new Logger(new LogBuffer(), 'test', 'error'),
    env: { publicUrl },
  });
  registries.push(registry);
  await registry.ensureInstances([{ plugin: 'jellyfin', enabled: true }]);
  const result = await registry.saveConfig('jellyfin', config);
  expect(result.ok).toBe(true);
  return { hub, registry };
}

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('jellyfin plugin', () => {
  it('publishes the matching stream, with proxied artwork, and serves the proxy publicly', async () => {
    let sessions = [episodeSession, trackSession, { UserName: 'tsuni', Client: 'Jellyfin Web' }];
    const j = await fakeServer('Jellyfin', () => sessions);
    const { hub, registry } = await boot(
      { url: j.url, apiKey: 'good-key', users: ['tsuni'], proxyArt: true, smallImage: 'jellyfin' },
      'https://rpc.example',
    );
    await until(() => !!hub.get('jellyfin'));
    const a = hub.get('jellyfin')!.activity;
    expect(a).toMatchObject({ name: 'Jellyfin', title: 'Twin Peaks', kind: 'watching', paused: true, smallImage: { url: 'jellyfin' } });
    expect(a.links).toEqual([{ label: 'IMDb', url: 'https://www.imdb.com/title/tt0098936/' }]);
    expect(a.largeImage).toMatchObject({ text: 'Twin Peaks' });
    expect(a.largeImage?.url).toMatch(/^https:\/\/rpc\.example\/public\/jellyfin\/art\/series1\.[\w-]+\.jpg$/);
    expect(registry.get('jellyfin')?.status.message).toBe('Paused on Firefox (tsuni)');

    const live = registry.get('jellyfin')!.live!;
    const img = await live.publicApp.request(new URL(a.largeImage!.url).pathname);
    expect(img.status).toBe(200);
    expect(await img.text()).toBe('JPEG:/Items/series1/Images/Primary');
    expect((await live.publicApp.request('/public/jellyfin/art/series1.forged.jpg')).status).toBe(404);

    // The API key never appears in anything we publish.
    expect(JSON.stringify(a)).not.toContain('good-key');

    sessions = [trackSession];
    await registry.restart('jellyfin');
    await until(() => registry.get('jellyfin')?.status.message === 'Nothing playing (1 other stream filtered out)');
    expect(hub.get('jellyfin')).toBeUndefined();
  });

  it('talks to Emby under /emby and names the activity after it', async () => {
    const e = await fakeServer('Emby', () => [movieSession]);
    const { hub } = await boot({ serverType: 'Emby', url: e.url, apiKey: 'good-key', albumArt: false });
    await until(() => !!hub.get('jellyfin'));
    expect(hub.get('jellyfin')!.activity).toMatchObject({ name: 'Emby', title: 'The Matrix (1999)' });
    expect(e.seen[0]?.pathname).toBe('/emby/Sessions');
  });

  it('reports a bad API key', async () => {
    const j = await fakeServer('Jellyfin', () => []);
    const { registry } = await boot({ url: j.url, apiKey: 'wrong' });
    await until(() => registry.get('jellyfin')?.status.health === 'error');
    expect(registry.get('jellyfin')?.status.message).toBe('Jellyfin rejected the API key');
  });

  it('asks for setup when unconfigured', async () => {
    const { registry } = await boot({});
    expect(registry.get('jellyfin')?.status).toEqual({ health: 'setup', message: 'Set the Jellyfin URL and API key' });
  });
});
