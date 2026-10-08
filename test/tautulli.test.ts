import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderTemplate } from '../src/core/template.js';
import { Hub } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { emptyConfig, Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore } from '../src/core/store.js';
import { ArtworkResolver, parseGuids, signThumb, verifyThumb } from '../src/plugins/tautulli/artwork.js';
import { TautulliClient, type TautulliSession } from '../src/plugins/tautulli/client.js';
import { tautulliPlugin } from '../src/plugins/tautulli/index.js';
import { AlbumArtFinder, normaliseAlbum } from '../src/plugins/tautulli/music.js';
import { chooseSession, matchesFilter, toNowPlaying } from '../src/plugins/tautulli/session.js';
import { quietLogger, scriptedFetch } from './helpers.js';

const templates = tautulliPlugin.configSchema.parse({}) as unknown as Parameters<typeof toNowPlaying>[1]['templates'];

const movieSession: TautulliSession = {
  session_key: '12',
  rating_key: '603',
  media_type: 'movie',
  state: 'playing',
  title: 'The Matrix',
  full_title: 'The Matrix',
  year: '1999',
  view_offset: '600000',
  duration: '8160000',
  thumb: '/library/metadata/603/thumb/1700000000',
  genres: ['Science Fiction', 'Action'],
  directors: ['Lana Wachowski', 'Lilly Wachowski'],
  user: 'tsuni',
  friendly_name: 'Tsuni',
  player: 'Living Room TV',
};

const episodeSession: TautulliSession = {
  rating_key: '9001',
  grandparent_rating_key: '9000',
  media_type: 'episode',
  state: 'paused',
  title: 'Pilot',
  grandparent_title: 'Twin Peaks',
  full_title: 'Twin Peaks - Pilot',
  parent_media_index: '1',
  media_index: '1',
  view_offset: '60000',
  duration: '5400000',
  grandparent_thumb: '/library/metadata/9000/thumb/1',
  user: 'tsuni',
  player: 'Laptop',
};

const trackSession: TautulliSession = {
  rating_key: '777',
  media_type: 'track',
  state: 'playing',
  title: 'Windowlicker',
  parent_title: 'Windowlicker',
  grandparent_title: 'Aphex Twin',
  view_offset: '1000',
  duration: '366000',
  parent_thumb: '/library/metadata/776/thumb/1',
  user: 'someone-else',
  player: 'Phone',
};

describe('renderTemplate', () => {
  it('fills variables and drops optional groups with empty variables', () => {
    expect(renderTemplate('S{s}E{e}[ · {t}]', { s: '01', e: '02', t: 'Pilot' })).toBe('S01E02 · Pilot');
    expect(renderTemplate('S{s}E{e}[ · {t}]', { s: '01', e: '02', t: '' })).toBe('S01E02');
    expect(renderTemplate('{title}[ ({year})]', { title: 'Heat' })).toBe('Heat');
  });

  it('trims dangling separators', () => {
    const tpl = '[{genre}] · [Dir. {director}]';
    expect(renderTemplate(tpl, { genre: 'Drama', director: 'Mann' })).toBe('Drama · Dir. Mann');
    expect(renderTemplate(tpl, { director: 'Mann' })).toBe('Dir. Mann');
    expect(renderTemplate(tpl, { genre: 'Drama' })).toBe('Drama');
    expect(renderTemplate(tpl, {})).toBe('');
  });
});

describe('session mapping', () => {
  it('maps a movie with timestamps from the playback offset', () => {
    const a = toNowPlaying(movieSession, { name: 'Plex', templates, now: 10_000_000 });
    expect(a).toEqual({
      key: 'tautulli:603',
      kind: 'watching',
      name: 'Plex',
      title: 'The Matrix (1999)',
      subtitle: 'Science Fiction · Dir. Lana Wachowski',
      startedAt: 9_400_000,
      endsAt: 9_400_000 + 8_160_000,
    });
  });

  it('maps a paused episode', () => {
    const a = toNowPlaying(episodeSession, { name: 'Plex', templates, now: 1_000_000 });
    expect(a).toMatchObject({ kind: 'watching', title: 'Twin Peaks', subtitle: 'S01E01 · Pilot', paused: true });
  });

  it('maps a track as listening', () => {
    const a = toNowPlaying(trackSession, { name: 'Plex', templates, now: 1_000_000 });
    expect(a).toMatchObject({ kind: 'listening', title: 'Windowlicker', subtitle: 'by Aphex Twin' });
  });

  it('filters by user and player, case-insensitively', () => {
    expect(matchesFilter(movieSession, { users: ['TSUNI'], players: [] })).toBe(true);
    expect(matchesFilter(movieSession, { users: ['tsuni'], players: ['laptop'] })).toBe(false);
    expect(matchesFilter(trackSession, { users: ['tsuni'], players: [] })).toBe(false);
    expect(matchesFilter(trackSession, { users: [], players: [] })).toBe(true);
  });

  it('prefers playing over paused, and video over music', () => {
    expect(chooseSession([episodeSession, trackSession])?.rating_key).toBe('777');
    expect(chooseSession([trackSession, movieSession])?.rating_key).toBe('603');
    expect(chooseSession([])).toBeUndefined();
  });
});

describe('artwork', () => {
  it('parses new-agent and legacy guids', () => {
    expect(parseGuids({ guids: ['imdb://tt0133093', 'tmdb://603', 'tvdb://169'] })).toEqual({ imdb: 'tt0133093', tmdb: '603', tvdb: '169' });
    expect(parseGuids({ guid: 'com.plexapp.agents.imdb://tt0133093?lang=en' })).toEqual({ imdb: 'tt0133093' });
    expect(parseGuids({ guid: 'com.plexapp.agents.thetvdb://121361/6/1?lang=en' })).toEqual({ tvdb: '121361' });
    expect(parseGuids({ guid: 'plex://movie/5d776825880197001ec967c6' })).toEqual({});
  });

  it('signs and verifies proxy tokens, and only for Plex library paths', () => {
    const token = signThumb('/library/metadata/603/thumb/1', 'secret');
    expect(verifyThumb(token, 'secret')).toBe('/library/metadata/603/thumb/1');
    expect(verifyThumb(token, 'other-secret')).toBeUndefined();
    expect(verifyThumb(token.replace(/^\w/, 'x'), 'secret')).toBeUndefined();
    expect(verifyThumb(signThumb('http://evil.example/x', 'secret'), 'secret')).toBeUndefined();
  });

  it('uses the TMDB poster for movies, with an IMDb link', async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { response: { result: 'success', data: { guids: ['imdb://tt0133093', 'tmdb://603'] } } } },
      { status: 200, body: { poster_path: '/matrix.jpg' } },
    ]);
    const client = new TautulliClient('http://tautulli:8181', 'k', fetch.impl);
    const r = new ArtworkResolver({ client, log: quietLogger(), tmdbKey: 'abc123', albumArt: true, fetchImpl: fetch.impl });
    const art = await r.resolve(movieSession);
    expect(art).toEqual({
      url: 'https://image.tmdb.org/t/p/w500/matrix.jpg',
      source: 'tmdb',
      links: [{ label: 'IMDb', url: 'https://www.imdb.com/title/tt0133093/' }],
    });
    expect(fetch.calls[1]?.url).toBe('https://api.themoviedb.org/3/movie/603?api_key=abc123');
    // Cached: no more requests.
    await r.resolve(movieSession);
    expect(fetch.calls).toHaveLength(2);
  });

  it('finds shows by tvdb id and sends v4 tokens as a bearer header', async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { response: { result: 'success', data: { guid: 'com.plexapp.agents.thetvdb://70533?lang=en' } } } },
      { status: 200, body: { tv_results: [{ poster_path: '/tp.jpg' }] } },
    ]);
    const client = new TautulliClient('http://tautulli:8181', 'k', fetch.impl);
    const r = new ArtworkResolver({ client, log: quietLogger(), tmdbKey: 'eyJhbGciOi.token', albumArt: true, fetchImpl: fetch.impl });
    expect((await r.resolve(episodeSession)).url).toBe('https://image.tmdb.org/t/p/w500/tp.jpg');
    expect(fetch.calls[0]?.url).toContain('rating_key=9000'); // the show's metadata, not the episode's
    expect(fetch.calls[1]?.url).toBe('https://api.themoviedb.org/3/find/70533?external_source=tvdb_id');
  });

  it('uses iTunes for album art, matching the album and ignoring store suffixes', async () => {
    const fetch = scriptedFetch([
      {
        status: 200,
        body: {
          results: [
            { collectionName: 'Selected Ambient Works', artistName: 'Aphex Twin', artworkUrl100: 'https://is1.mzstatic.com/a/100x100bb.jpg' },
            { collectionName: 'Windowlicker - EP', artistName: 'Aphex Twin', artworkUrl100: 'https://is1.mzstatic.com/b/100x100bb.jpg' },
            { collectionName: 'Windowlicker', artistName: 'Aphex Twin', artworkUrl100: 'https://is1.mzstatic.com/c/100x100bb.jpg' },
          ],
        },
      },
    ]);
    const client = new TautulliClient('http://tautulli:8181', 'k', fetch.impl);
    const r = new ArtworkResolver({ client, log: quietLogger(), albumArt: true, fetchImpl: fetch.impl });
    // "Windowlicker - EP" is the same release as Plex's "Windowlicker".
    expect(await r.resolve(trackSession)).toMatchObject({ source: 'itunes', url: 'https://is1.mzstatic.com/b/600x600bb.jpg' });
  });

  it('falls back to the proxy, then the fallback image, when lookups find nothing or fail', async () => {
    const fetch = scriptedFetch([{ status: 500, body: {} }]);
    const client = new TautulliClient('http://tautulli:8181', 'k', fetch.impl);
    const proxied = new ArtworkResolver({
      client,
      log: quietLogger(),
      albumArt: false,
      proxyUrl: (thumb) => `https://rpc.example${thumb}`,
      fetchImpl: fetch.impl,
    });
    expect(await proxied.resolve(movieSession)).toMatchObject({ source: 'proxy', url: 'https://rpc.example/library/metadata/603/thumb/1700000000' });

    const fallback = new ArtworkResolver({ client, log: quietLogger(), albumArt: false, fallback: 'plex', fetchImpl: fetch.impl });
    expect(await fallback.resolve(trackSession)).toMatchObject({ source: 'fallback', url: 'plex' });
  });
});

describe('album art finder', () => {
  it('normalises album names', () => {
    expect(normaliseAlbum('Outer Wilds - Reprise - Single')).toBe(normaliseAlbum('Outer Wilds - Reprise'));
    expect(normaliseAlbum('Nurture (Deluxe Edition)')).toBe('nurture');
    expect(normaliseAlbum('SMILE! :D')).toBe('smiled');
    expect(normaliseAlbum('超かぐや姫！')).toBe('超かぐや姫');
    expect(normaliseAlbum('Outer Wilds (Original Soundtrack)')).not.toBe(normaliseAlbum('Outer Wilds - Reprise'));
  });

  it('matches subtitle punctuation and soundtrack wording, preferring the strictest match', async () => {
    const fetch = scriptedFetch([
      {
        status: 200,
        body: {
          results: [
            { collectionName: 'Kingdom Two Crowns: Norse Lands Soundtrack (Extended)', artistName: 'Kalandra', artworkUrl100: 'https://x/loose/100x100bb.jpg' },
            { collectionName: 'DELTARUNE Chapter 5 (Original Game Soundtrack)', artistName: 'Toby Fox', artworkUrl100: 'https://x/d5/100x100bb.jpg' },
          ],
        },
      },
    ]);
    const finder = new AlbumArtFinder(fetch.impl);
    expect((await finder.find('Toby Fox', 'DELTARUNE Chapter 5: Original Game Soundtrack'))?.url).toBe('https://x/d5/600x600bb.jpg');
    const fetch2 = scriptedFetch([
      {
        status: 200,
        body: {
          results: [
            { collectionName: 'Kingdom Two Crowns: Norse Lands Soundtrack (Extended)', artistName: 'Kalandra', artworkUrl100: 'https://x/loose/100x100bb.jpg' },
            { collectionName: 'Kingdom Two Crowns: Norse Lands', artistName: 'Kalandra', artworkUrl100: 'https://x/exact/100x100bb.jpg' },
          ],
        },
      },
    ]);
    expect((await new AlbumArtFinder(fetch2.impl).find('Kalandra', 'Kingdom Two Crowns: Norse Lands'))?.url).toBe('https://x/exact/600x600bb.jpg');
  });

  it("falls back to the artist's iTunes discography when search misses the album", async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { results: [{ collectionName: 'Nurture', artistName: 'Porter Robinson', artworkUrl100: 'https://x/n/100x100bb.jpg' }] } },
      { status: 200, body: { results: [{ artistName: 'Porter Robinson', artistId: 282330711 }] } },
      {
        status: 200,
        body: {
          results: [
            { wrapperType: 'artist', artistName: 'Porter Robinson' },
            { wrapperType: 'collection', collectionName: 'SMILE! :D', artistName: 'Porter Robinson', artworkUrl100: 'https://x/s/100x100bb.jpg' },
          ],
        },
      },
    ]);
    const art = await new AlbumArtFinder(fetch.impl).find('Porter Robinson', 'SMILE! :D');
    expect(art).toEqual({ url: 'https://x/s/600x600bb.jpg', source: 'itunes' });
    expect(fetch.calls[2]?.url).toBe('https://itunes.apple.com/lookup?id=282330711&entity=album&limit=200');
  });

  it('falls back to Deezer, and checks the artist', async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { results: [] } },
      { status: 200, body: { results: [] } }, // artist not found on iTunes
      {
        status: 200,
        body: {
          data: [
            { title: 'SMILE! :D', artist: { name: 'Someone Else' }, cover_xl: 'https://dz/wrong.jpg' },
            { title: 'SMILE! :D', artist: { name: 'Porter Robinson' }, cover_xl: 'https://dz/right.jpg' },
          ],
        },
      },
    ]);
    expect(await new AlbumArtFinder(fetch.impl).find('Porter Robinson', 'SMILE! :D')).toEqual({ url: 'https://dz/right.jpg', source: 'deezer' });
  });

  it('returns nothing rather than a different album', async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { results: [{ collectionName: 'Outer Wilds (Original Soundtrack)', artistName: 'Andrew Prahlow', artworkUrl100: 'https://x/o/100x100bb.jpg' }] } },
      { status: 200, body: { results: [] } },
      { status: 200, body: { data: [] } },
    ]);
    expect(await new AlbumArtFinder(fetch.impl).find('Andrew Prahlow', 'Outer Wilds - Reprise')).toBeUndefined();
  });
});

// ---- plugin end to end, against a fake Tautulli ---------------------------------------------------

const dirs: string[] = [];
const servers: http.Server[] = [];
const registries: Registry[] = [];
afterEach(async () => {
  for (const r of registries.splice(0)) await r.stopAll();
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function fakeTautulli(sessions: () => TautulliSession[]) {
  const seen: URL[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(url);
    res.setHeader('Content-Type', 'application/json');
    if (url.searchParams.get('apikey') !== 'good-key') {
      res.end(JSON.stringify({ response: { result: 'error', message: 'Invalid apikey', data: {} } }));
      return;
    }
    const cmd = url.searchParams.get('cmd');
    if (cmd === 'get_activity') res.end(JSON.stringify({ response: { result: 'success', data: { sessions: sessions() } } }));
    else if (cmd === 'get_metadata') res.end(JSON.stringify({ response: { result: 'success', data: { guids: ['imdb://tt0133093'] } } }));
    else if (cmd === 'pms_image_proxy') {
      res.setHeader('Content-Type', 'image/jpeg');
      res.end('JPEGDATA');
    } else res.end(JSON.stringify({ response: { result: 'error', message: `unknown ${cmd}` } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function boot(config: Record<string, unknown>, publicUrl?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srpc-tautulli-'));
  dirs.push(dir);
  const hub = new Hub();
  const registry = new Registry({
    plugins: [tautulliPlugin],
    config: new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig),
    state: new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({})),
    hub,
    log: new Logger(new LogBuffer(), 'test', 'error'),
    env: { publicUrl },
  });
  registries.push(registry);
  await registry.ensureInstances([{ plugin: 'tautulli', enabled: true }]);
  const result = await registry.saveConfig('tautulli', config);
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

describe('tautulli plugin', () => {
  it('publishes the matching stream, with proxied artwork, and serves the proxy publicly', async () => {
    let sessions = [movieSession, trackSession];
    const t = await fakeTautulli(() => sessions);
    const { hub, registry } = await boot(
      { url: t.url, apiKey: 'good-key', users: ['tsuni'], proxyArt: true, smallImage: 'plex' },
      'https://rpc.example',
    );
    await until(() => !!hub.get('tautulli'));
    const a = hub.get('tautulli')!.activity;
    expect(a).toMatchObject({ title: 'The Matrix (1999)', kind: 'watching', smallImage: { url: 'plex' } });
    expect(a.links).toEqual([{ label: 'IMDb', url: 'https://www.imdb.com/title/tt0133093/' }]);
    expect(a.largeImage?.url).toMatch(/^https:\/\/rpc\.example\/public\/tautulli\/art\/[\w-]+\.[\w-]+\.jpg$/);
    expect(registry.get('tautulli')?.status.message).toBe('Playing on Living Room TV (Tsuni)');

    const live = registry.get('tautulli')!.live!;
    const artPath = new URL(a.largeImage!.url).pathname;
    const img = await live.publicApp.request(artPath);
    expect(img.status).toBe(200);
    expect(await img.text()).toBe('JPEGDATA');
    expect((await live.publicApp.request('/public/tautulli/art/forged.token.jpg')).status).toBe(404);

    // The API key never appears in anything we publish.
    expect(JSON.stringify(a)).not.toContain('good-key');

    sessions = [];
    await registry.restart('tautulli');
    await until(() => registry.get('tautulli')?.status.message === 'Nothing playing');
    expect(hub.get('tautulli')).toBeUndefined();
  });

  it('reports a bad API key', async () => {
    const t = await fakeTautulli(() => []);
    const { registry } = await boot({ url: t.url, apiKey: 'wrong' });
    await until(() => registry.get('tautulli')?.status.health === 'error');
    expect(registry.get('tautulli')?.status.message).toBe('Tautulli rejected the API key');
  });

  it('asks for setup when unconfigured', async () => {
    const { registry } = await boot({});
    expect(registry.get('tautulli')?.status).toEqual({ health: 'setup', message: 'Set the Tautulli URL and API key' });
  });
});
