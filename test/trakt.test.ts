import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { emptyConfig, Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore } from '../src/core/store.js';
import { ArtworkResolver } from '../src/plugins/trakt/artwork.js';
import { parseRetryAfter } from '../src/plugins/shared/http.js';
import { TraktAuthError, TraktClient, type TraktWatching } from '../src/plugins/trakt/client.js';
import { createTraktPlugin, traktPlugin } from '../src/plugins/trakt/index.js';
import { itemKey, itemLinks, toNowPlaying, traktUrl } from '../src/plugins/trakt/watching.js';
import { createWebApp } from '../src/web/app.js';
import { quietLogger, scriptedFetch } from './helpers.js';

const templates = traktPlugin.configSchema.parse({}) as unknown as Parameters<typeof toNowPlaying>[1]['templates'];

const movieWatching: TraktWatching = {
  started_at: '2026-10-09T12:00:00.000Z',
  expires_at: '2026-10-09T14:16:00.000Z',
  action: 'scrobble',
  type: 'movie',
  movie: { title: 'The Matrix', year: 1999, ids: { trakt: 481, slug: 'the-matrix-1999', imdb: 'tt0133093', tmdb: 603 } },
};

const episodeWatching = (season: number, number: number, title: string): TraktWatching => ({
  started_at: '2026-10-09T20:00:00.000Z',
  expires_at: '2026-10-09T20:47:00.000Z',
  action: 'checkin',
  type: 'episode',
  episode: { season, number, title, ids: { trakt: 70000 + number, tvdb: 300000 + number, imdb: null, tmdb: null } },
  show: { title: 'Twin Peaks', year: 1990, ids: { trakt: 1395, slug: 'twin-peaks', tvdb: 70533, imdb: 'tt0098936', tmdb: 1920 } },
});

describe('watching mapping', () => {
  it('maps a movie, with the progress bar from started_at/expires_at', () => {
    expect(toNowPlaying(movieWatching, { name: 'Trakt', templates })).toEqual({
      key: 'trakt:movie:481',
      kind: 'watching',
      name: 'Trakt',
      title: 'The Matrix (1999)',
      startedAt: Date.parse('2026-10-09T12:00:00.000Z'),
      endsAt: Date.parse('2026-10-09T14:16:00.000Z'),
    });
  });

  it('maps an episode with the episode templates, keyed by the episode', () => {
    const a = toNowPlaying(episodeWatching(1, 2, 'Traces to Nowhere'), { name: 'Trakt', templates });
    expect(a).toMatchObject({ key: 'trakt:episode:70002', title: 'Twin Peaks', subtitle: 'S01E02 · Traces to Nowhere' });
    const custom = { ...templates, episodeTitle: '{title}', episodeSubtitle: '{show} ({year}) · {season}x{episode}' };
    expect(toNowPlaying(episodeWatching(2, 10, 'Coma'), { name: 'Trakt', templates: custom })).toMatchObject({
      title: 'Coma',
      subtitle: 'Twin Peaks (1990) · 2x10',
    });
  });

  it('ignores items it cannot show, and bad timestamps', () => {
    expect(toNowPlaying({ type: 'episode', episode: { season: 1, number: 1 } }, { name: 'Trakt', templates })).toBeUndefined();
    const a = toNowPlaying({ ...movieWatching, started_at: 'nope' }, { name: 'Trakt', templates });
    expect(a?.startedAt).toBeUndefined();
    expect(a?.endsAt).toBeUndefined();
    expect(itemKey({ ...movieWatching, movie: { title: 'X', ids: { slug: 'x-2020' } } })).toBe('trakt:movie:x-2020');
  });

  it('links to IMDb (the show, for episodes) and the Trakt page', () => {
    const ep = episodeWatching(1, 2, 'Traces to Nowhere');
    expect(traktUrl(movieWatching)).toBe('https://trakt.tv/movies/the-matrix-1999');
    expect(traktUrl(ep)).toBe('https://trakt.tv/shows/twin-peaks/seasons/1/episodes/2');
    expect(itemLinks(ep, 'both')).toEqual([
      { label: 'IMDb', url: 'https://www.imdb.com/title/tt0098936/' },
      { label: 'Trakt', url: 'https://trakt.tv/shows/twin-peaks/seasons/1/episodes/2' },
    ]);
    expect(itemLinks(movieWatching, 'trakt')).toEqual([{ label: 'Trakt', url: 'https://trakt.tv/movies/the-matrix-1999' }]);
    const noImdb = { ...movieWatching, movie: { ...movieWatching.movie!, ids: { trakt: 481, slug: 'the-matrix-1999', tmdb: 603 } } };
    expect(itemLinks(noImdb, 'imdb')).toEqual([{ label: 'TMDB', url: 'https://www.themoviedb.org/movie/603' }]);
    expect(itemLinks(movieWatching, 'none')).toEqual([]);
  });
});

describe('Trakt client', () => {
  it('sends the required headers, and reads 204 as nothing playing', async () => {
    const seen: Headers[] = [];
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = new TraktClient({ clientId: 'cid', fetchImpl: impl });
    expect(await client.watching('sean')).toBeNull();
    expect(Object.fromEntries(seen[0]!)).toMatchObject({
      'content-type': 'application/json',
      'trakt-api-key': 'cid',
      'trakt-api-version': '2',
    });
    expect(seen[0]!.get('user-agent')).toMatch(/^understudy\/\d/);
    expect(seen[0]!.has('authorization')).toBe(false);
    await client.watching('me', 'tok');
    expect(seen[1]!.get('authorization')).toBe('Bearer tok');
  });

  it('explains private profiles, unknown users and rate limits', async () => {
    const fetch = scriptedFetch([
      { status: 401 },
      { status: 404 },
      {
        status: 429,
        headers: { 'Retry-After': '20', 'X-Ratelimit': '{"name":"UNAUTHED_API_GET_LIMIT","period":300,"limit":500,"remaining":0}' },
      },
    ]);
    const client = new TraktClient({ clientId: 'cid', fetchImpl: fetch.impl });
    await expect(client.watching('sean')).rejects.toThrow("sean's Trakt profile is private; connect your Trakt account to show it");
    await expect(client.watching('nobody')).rejects.toThrow('Trakt user "nobody" not found');
    await expect(client.watching('sean')).rejects.toMatchObject({
      message: 'Trakt rate limit reached (UNAUTHED_API_GET_LIMIT)',
      status: 429,
      retryAfterMs: 20_000,
    });
    expect(fetch.calls[0]?.url).toBe('https://api.trakt.tv/users/sean/watching');
  });

  it('maps device token poll statuses', async () => {
    const fetch = scriptedFetch([
      { status: 400 },
      { status: 429, headers: { 'Retry-After': '3' } },
      { status: 418 },
      { status: 410 },
      { status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 604800, token_type: 'bearer', scope: 'public', created_at: 1 } },
    ]);
    const client = new TraktClient({ clientId: 'cid', fetchImpl: fetch.impl });
    expect(await client.pollDeviceToken('dc')).toEqual({ status: 'pending' });
    expect(await client.pollDeviceToken('dc')).toEqual({ status: 'slow_down', retryAfterMs: 3000 });
    expect(await client.pollDeviceToken('dc')).toMatchObject({ status: 'failed', message: 'Access was denied on Trakt.' });
    expect(await client.pollDeviceToken('dc')).toMatchObject({ status: 'failed', message: /expired/ });
    const ok = await client.pollDeviceToken('dc');
    expect(ok).toMatchObject({ status: 'ok', tokens: { accessToken: 'a', refreshToken: 'r' } });
    if (ok.status === 'ok') expect(ok.tokens.expiresAt - ok.tokens.createdAt).toBe(604_800_000);
    expect(fetch.calls[0]).toMatchObject({ method: 'POST', url: 'https://auth.trakt.tv/oauth/device/token', body: { code: 'dc', client_id: 'cid' } });
  });

  it('refreshes with the device redirect URI, and reports a dead refresh token', async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { access_token: 'a2', refresh_token: 'r2', expires_in: 604800 } },
      { status: 400, body: { error: 'invalid_grant', error_description: 'session not found' } },
    ]);
    const client = new TraktClient({ clientId: 'cid', clientSecret: 'sec', fetchImpl: fetch.impl });
    expect(await client.refresh('r1')).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
    expect(fetch.calls[0]).toMatchObject({
      url: 'https://auth.trakt.tv/oauth/token',
      body: { refresh_token: 'r1', client_id: 'cid', client_secret: 'sec', redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'refresh_token' },
    });
    const err = await client.refresh('r2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TraktAuthError);
    expect((err as Error).message).toMatch(/invalid_grant: session not found/);
    expect((err as Error).message).not.toContain('r2');
  });

  it('parses Retry-After', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', Date.parse('2026-01-01T00:00:00Z'))).toBe(60_000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('artwork', () => {
  it("uses the show's TMDB poster, once per show", async () => {
    const fetch = scriptedFetch([{ status: 200, body: { poster_path: '/tp.jpg' } }]);
    const r = new ArtworkResolver({ log: quietLogger(), tmdbKey: 'k', fetchImpl: fetch.impl });
    expect(await r.resolve(episodeWatching(1, 1, 'Pilot'))).toEqual({ url: 'https://image.tmdb.org/t/p/w500/tp.jpg', source: 'tmdb' });
    expect(await r.resolve(episodeWatching(1, 2, 'Traces to Nowhere'))).toMatchObject({ source: 'tmdb' });
    expect(fetch.calls.map((c) => c.url)).toEqual(['https://api.themoviedb.org/3/tv/1920?api_key=k']);
  });

  it('falls back when TMDB has nothing, fails, or has no key', async () => {
    const fetch = scriptedFetch([{ status: 500 }]);
    const r = new ArtworkResolver({ log: quietLogger(), tmdbKey: 'k', fallback: 'trakt', fetchImpl: fetch.impl });
    expect(await r.resolve(movieWatching)).toEqual({ url: 'trakt', source: 'fallback' });
    expect(await new ArtworkResolver({ log: quietLogger() }).resolve(movieWatching)).toEqual({ source: 'none' });
  });
});

// ---- plugin flow against a fake Trakt ------------------------------------------------------------

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fake Trakt (and TMDB): `handle` answers each request; everything is recorded. */
function fakeTrakt(handle: (call: Call) => Reply | undefined) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const r = handle(call) ?? { status: 404 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const to = (p: string) => calls.filter((c) => c.url.pathname === p);
  return { impl, calls, to };
}

const tokenBody = (n: number, expiresIn = 604800) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: expiresIn,
  token_type: 'bearer',
  scope: 'public',
  created_at: Math.floor(Date.now() / 1000),
});

const dirs: string[] = [];
const registries: Registry[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 20)); // let state writes finish
  for (const r of registries.splice(0)) await r.stopAll();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function boot(handle: (call: Call) => Reply | undefined, config: Record<string, unknown>, state?: Record<string, unknown>) {
  const trakt = fakeTrakt(handle);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srpc-trakt-'));
  dirs.push(dir);
  if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ trakt: state }));
  const hub = new Hub();
  const logs = new LogBuffer();
  const stateStore = new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({}));
  const registry = new Registry({
    plugins: [createTraktPlugin(trakt.impl)],
    config: new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig),
    state: stateStore,
    hub,
    log: new Logger(logs, 'test', 'error'),
    env: { publicUrl: undefined },
  });
  registries.push(registry);
  await registry.ensureInstances([{ plugin: 'trakt', enabled: true }]);
  expect((await registry.saveConfig('trakt', config)).ok).toBe(true);
  const app = createWebApp({ registry, hub, logs, env: { publicUrl: undefined }, uiPassword: undefined });
  const post = (p: string) =>
    app.request(p, { method: 'POST', body: new URLSearchParams(), headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' } });
  const page = async () => (await app.request('/instances/trakt')).text();
  const saved = () => (stateStore.get().trakt ?? {}) as Record<string, any>;
  return { trakt, hub, registry, post, page, saved, status: () => registry.get('trakt')!.status };
}

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('trakt plugin', () => {
  it('asks for setup when unconfigured', async () => {
    const { status } = await boot(() => undefined, {});
    expect(status()).toEqual({ health: 'setup', message: 'Set the Trakt client ID' });
    const { status: s2 } = await boot(() => undefined, { clientId: 'cid' });
    expect(s2()).toEqual({ health: 'setup', message: 'Set your Trakt username, or connect your account' });
  });

  it('publishes a public profile with poster and buttons, without OAuth', async () => {
    let watching: TraktWatching | null = movieWatching;
    const t = await boot(
      (c) => {
        if (c.url.pathname === '/users/sean/watching') return watching ? { status: 200, body: watching } : { status: 204 };
        if (c.url.hostname === 'api.themoviedb.org') return { status: 200, body: { poster_path: '/matrix.jpg' } };
      },
      { clientId: 'cid', username: 'sean', tmdbKey: 'k', smallImage: 'trakt' },
    );
    await until(() => !!t.hub.get('trakt'));
    expect(t.hub.get('trakt')!.activity).toEqual({
      key: 'trakt:movie:481',
      kind: 'watching',
      name: 'Trakt',
      title: 'The Matrix (1999)',
      startedAt: Date.parse(movieWatching.started_at!),
      endsAt: Date.parse(movieWatching.expires_at!),
      largeImage: { url: 'https://image.tmdb.org/t/p/w500/matrix.jpg', text: 'The Matrix' },
      smallImage: { url: 'trakt', text: 'Trakt' },
      links: [
        { label: 'IMDb', url: 'https://www.imdb.com/title/tt0133093/' },
        { label: 'Trakt', url: 'https://trakt.tv/movies/the-matrix-1999' },
      ],
    });
    expect(t.status()).toEqual({ health: 'ok', message: 'Watching The Matrix (1999)' });
    expect(t.trakt.to('/users/sean/watching')[0]!.headers.has('authorization')).toBe(false);

    watching = null;
    await t.registry.restart('trakt');
    await until(() => t.status().message === 'Not watching anything');
    expect(t.hub.get('trakt')).toBeUndefined();
  });

  it('connects a private profile with a device code, then polls it with the token', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let approved = false;
    const t = await boot((c) => {
      switch (c.url.pathname) {
        case '/oauth/device/code':
          return { status: 200, body: { device_code: 'secret-device-code', user_code: 'ABCD1234', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 } };
        case '/oauth/device/token':
          return approved ? { status: 200, body: tokenBody(1) } : { status: 400 };
        case '/users/me':
          return { status: 200, body: { username: 'Sean', ids: { slug: 'sean' } } };
        case '/users/me/watching':
          return { status: 200, body: episodeWatching(1, 2, 'Traces to Nowhere') };
        case '/oauth/revoke':
          return { status: 200 };
      }
    }, { clientId: 'cid' });
    expect(await t.page()).toContain('Connect Trakt');

    await t.post('/plugins/trakt/connect');
    expect(t.status()).toEqual({ health: 'setup', message: 'Enter the code ABCD1234 at https://trakt.tv/activate' });
    const page = await t.page();
    expect(page).toContain('ABCD1234');
    expect(page).not.toContain('secret-device-code');

    // Polls at the code's interval, not faster.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(t.trakt.to('/oauth/device/token')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.trakt.to('/oauth/device/token')).toHaveLength(1);
    approved = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.trakt.to('/oauth/device/token')).toHaveLength(2);
    expect(t.trakt.to('/oauth/device/token')[0]!.body).toEqual({ code: 'secret-device-code', client_id: 'cid' });

    expect(t.saved()).toMatchObject({ account: 'Sean', tokens: { accessToken: 'access-1', refreshToken: 'refresh-1' } });
    expect(t.saved().pending).toBeUndefined();
    expect(t.hub.get('trakt')?.activity).toMatchObject({ title: 'Twin Peaks', subtitle: 'S01E02 · Traces to Nowhere' });
    expect(t.trakt.to('/users/me/watching')[0]!.headers.get('authorization')).toBe('Bearer access-1');
    expect(t.status()).toEqual({ health: 'ok', message: 'Checked in to Twin Peaks' });
    const connected = await t.page();
    expect(connected).toContain('Connected as <strong>Sean</strong>');
    expect(connected).not.toContain('access-1');
    expect(connected).not.toContain('refresh-1');

    // No more device polling once connected; watching is polled every 30 s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.trakt.to('/oauth/device/token')).toHaveLength(2);
    expect(t.trakt.to('/users/me/watching')).toHaveLength(2);

    await t.post('/plugins/trakt/disconnect');
    expect(t.trakt.to('/oauth/revoke')[0]!.body).toMatchObject({ token: 'access-1', client_id: 'cid' });
    expect(t.saved().tokens).toBeUndefined();
    expect(t.hub.get('trakt')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.trakt.to('/users/me/watching')).toHaveLength(2);
  });

  it('stops waiting for a denied or expired code', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let tokenStatus = 400;
    const t = await boot((c) => {
      if (c.url.pathname === '/oauth/device/code') {
        return { status: 200, body: { device_code: 'dc', user_code: 'CODE', verification_url: 'https://trakt.tv/activate', expires_in: 12, interval: 5 } };
      }
      if (c.url.pathname === '/oauth/device/token') return { status: tokenStatus };
    }, { clientId: 'cid' });

    await t.post('/plugins/trakt/connect');
    await vi.advanceTimersByTimeAsync(60_000);
    // 5 s, 10 s, then once more at expiry (12 s), which finds it expired.
    expect(t.trakt.to('/oauth/device/token')).toHaveLength(2);
    expect(t.status()).toEqual({ health: 'error', message: 'The code expired before it was entered. Connect again.' });

    tokenStatus = 418;
    await t.post('/plugins/trakt/connect');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.status()).toEqual({ health: 'error', message: 'Access was denied on Trakt.' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.trakt.to('/oauth/device/token')).toHaveLength(3);
  });

  it('slows down when Trakt says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t = await boot((c) => {
      if (c.url.pathname === '/oauth/device/code') {
        return { status: 200, body: { device_code: 'dc', user_code: 'CODE', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 } };
      }
      if (c.url.pathname === '/oauth/device/token') return { status: 429 };
    }, { clientId: 'cid' });
    await t.post('/plugins/trakt/connect');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.trakt.to('/oauth/device/token')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(t.trakt.to('/oauth/device/token')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.trakt.to('/oauth/device/token')).toHaveLength(2);
  });

  it('renews the token before it expires, storing the new single-use refresh token', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const now = Date.now();
    let n = 1;
    const t = await boot(
      (c) => {
        if (c.url.pathname === '/oauth/token') return { status: 200, body: tokenBody(++n) };
        if (c.url.pathname === '/users/me/watching') return { status: 204 };
      },
      { clientId: 'cid' },
      // 6 of 7 days gone: past the renewal point.
      { tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', createdAt: now - 6 * 86400_000, expiresAt: now + 86400_000 }, account: 'Sean' },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(t.trakt.to('/oauth/token')).toHaveLength(1);
    expect(t.trakt.to('/oauth/token')[0]!.body).toMatchObject({ refresh_token: 'refresh-1', grant_type: 'refresh_token' });
    expect(t.trakt.to('/users/me/watching')[0]!.headers.get('authorization')).toBe('Bearer access-2');
    expect(t.saved().tokens).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.trakt.to('/oauth/token')).toHaveLength(1);
    expect(t.status()).toEqual({ health: 'idle', message: 'Not watching anything' });
  });

  it('disconnects when Trakt no longer accepts the refresh token', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const now = Date.now();
    const t = await boot(
      (c) => {
        if (c.url.pathname === '/oauth/token') return { status: 400, body: { error: 'invalid_grant', error_description: 'session not found' } };
        if (c.url.pathname === '/users/me/watching') return { status: 401 };
      },
      { clientId: 'cid' },
      { tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', createdAt: now - 3600_000, expiresAt: now + 6 * 86400_000 } },
    );
    // The access token is rejected early; one refresh is tried, and fails for good.
    await vi.advanceTimersByTimeAsync(0);
    expect(t.trakt.to('/oauth/token')).toHaveLength(1);
    expect(t.saved().tokens).toBeUndefined();
    expect(t.status()).toEqual({ health: 'error', message: expect.stringMatching(/no longer accepts this connection.*connect again/) });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.trakt.to('/users/me/watching')).toHaveLength(1);
  });

  it('waits as long as Retry-After says when rate limited, and backs off otherwise', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const replies: Reply[] = [
      { status: 429, headers: { 'Retry-After': '120' } },
      { status: 503 },
      { status: 200, body: movieWatching },
    ];
    const t = await boot((c) => (c.url.pathname === '/users/sean/watching' ? replies.shift() : undefined), { clientId: 'cid', username: 'sean' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.status()).toEqual({ health: 'error', message: 'Trakt rate limit reached' });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(t.trakt.to('/users/sean/watching')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.trakt.to('/users/sean/watching')).toHaveLength(2);
    expect(t.status().message).toBe('Trakt is unavailable (503)');
    // Second failure in a row: 30 s × 2².
    await vi.advanceTimersByTimeAsync(119_000);
    expect(t.trakt.to('/users/sean/watching')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.status()).toEqual({ health: 'ok', message: 'Watching The Matrix (1999)' });
  });
});
