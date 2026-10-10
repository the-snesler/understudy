import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { emptyConfig, Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore } from '../src/core/store.js';
import { createWebApp } from '../src/web/app.js';
import { parseSteamId, SteamClient, SteamStore, type PlayerSummary } from '../src/plugins/steam/client.js';
import { createSteamPlugin } from '../src/plugins/steam/index.js';
import { currentGame, isAppId, isIgnored, toNowPlaying } from '../src/plugins/steam/presence.js';
import { scriptedFetch } from './helpers.js';

const STEAM_ID = '76561197960287930';
const SHORTCUT_ID = '15190414816125648896';
const HEADER = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145360/header.jpg?t=1758127023';

const player = (game?: { gameid?: string; gameextrainfo?: string }, extra: Partial<PlayerSummary> = {}): PlayerSummary => ({
  steamid: STEAM_ID,
  personaname: 'Tsuni',
  avatarfull: 'https://avatars.steamstatic.com/a_full.jpg',
  personastate: 1,
  communityvisibilitystate: 3,
  ...game,
  ...extra,
});

describe('Steam ID input', () => {
  it('accepts a SteamID64, profile URLs and custom URL names', () => {
    expect(parseSteamId(STEAM_ID)).toEqual({ steamId: STEAM_ID });
    expect(parseSteamId(`https://steamcommunity.com/profiles/${STEAM_ID}/`)).toEqual({ steamId: STEAM_ID });
    expect(parseSteamId('steamcommunity.com/id/gabelogannewell')).toEqual({ vanity: 'gabelogannewell' });
    expect(parseSteamId(' https://steamcommunity.com/id/Tsuni_-x/home ')).toEqual({ vanity: 'Tsuni_-x' });
    expect(parseSteamId('tsuni')).toEqual({ vanity: 'tsuni' });
    expect(parseSteamId('https://steamcommunity.com/profiles/abc')).toBeUndefined();
    expect(parseSteamId('https://example.com/id/x')).toBeUndefined();
    expect(parseSteamId('two words')).toBeUndefined();
  });
});

describe('Steam presence mapping', () => {
  const opts = { activityName: 'Steam', smallImage: '', storeButton: true };

  it('tells app ids from non-Steam shortcut ids', () => {
    expect(isAppId('1145360')).toBe(true);
    expect(isAppId(SHORTCUT_ID)).toBe(false);
    expect(isAppId('0')).toBe(false);
    expect(currentGame(player())).toBeUndefined();
    expect(currentGame(player({ gameid: '0' }))).toBeUndefined();
    expect(currentGame(player({ gameid: '1145360', gameextrainfo: 'Hades' }))).toEqual({ gameId: '1145360', appId: '1145360', name: 'Hades' });
    expect(currentGame(player({ gameid: SHORTCUT_ID, gameextrainfo: 'RetroArch' }))).toEqual({ gameId: SHORTCUT_ID, name: 'RetroArch' });
  });

  it('maps a game, with a store button only for real apps', () => {
    const hades = currentGame(player({ gameid: '1145360', gameextrainfo: 'Hades' }))!;
    expect(toNowPlaying(STEAM_ID, hades, { ...opts, smallImage: 'steam' }, HEADER, 1000)).toEqual({
      key: `steam:${STEAM_ID}:1145360`,
      kind: 'playing',
      name: 'Steam',
      title: 'Hades',
      startedAt: 1000,
      largeImage: { url: HEADER, text: 'Hades' },
      smallImage: { url: 'steam', text: 'Steam' },
      links: [{ label: 'View on Steam', url: 'https://store.steampowered.com/app/1145360/' }],
    });
    const shortcut = currentGame(player({ gameid: SHORTCUT_ID, gameextrainfo: 'RetroArch' }))!;
    const a = toNowPlaying(STEAM_ID, shortcut, opts, undefined, 1000);
    expect(a).toMatchObject({ title: 'RetroArch', key: `steam:${STEAM_ID}:${SHORTCUT_ID}` });
    expect(a.links).toBeUndefined();
    expect(a.largeImage).toBeUndefined();
  });

  it('ignores by app id or name, case-insensitively', () => {
    const hades = currentGame(player({ gameid: '1145360', gameextrainfo: 'Hades' }))!;
    expect(isIgnored(hades, ['1145360'])).toBe(true);
    expect(isIgnored(hades, ['hades'])).toBe(true);
    expect(isIgnored(hades, ['Hades II', '620'])).toBe(false);
    const shortcut = currentGame(player({ gameid: SHORTCUT_ID, gameextrainfo: 'RetroArch' }))!;
    expect(isIgnored(shortcut, ['retroarch'])).toBe(true);
  });
});

describe('Steam Web API client', () => {
  it('calls GetPlayerSummaries and resolves custom URLs', async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { response: { success: 1, steamid: STEAM_ID } } },
      { status: 200, body: { response: { players: [player({ gameid: '1145360', gameextrainfo: 'Hades' })] } } },
      { status: 200, body: { response: { success: 42, message: 'No match' } } },
    ]);
    const client = new SteamClient('k3y', fetch.impl);
    expect(await client.resolveVanity('tsuni')).toBe(STEAM_ID);
    expect(fetch.calls[0]?.url).toBe('https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=k3y&vanityurl=tsuni');
    expect((await client.summary(STEAM_ID)).gameextrainfo).toBe('Hades');
    expect(fetch.calls[1]?.url).toBe(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=k3y&steamids=${STEAM_ID}`);
    await expect(client.resolveVanity('nobody')).rejects.toThrow('No Steam profile has the custom URL "nobody"');
  });

  it('reports a rejected key, rate limits and server errors without the key', async () => {
    const fetch = scriptedFetch([
      { status: 403 },
      { status: 429, headers: { 'Retry-After': '120' } },
      { status: 503 },
      { status: 200, body: { response: { players: [] } } },
    ]);
    const client = new SteamClient('secret-key', fetch.impl);
    await expect(client.summary(STEAM_ID)).rejects.toThrow('Steam rejected the Web API key');
    await expect(client.summary(STEAM_ID)).rejects.toMatchObject({ message: 'Steam is rate limiting requests (429)', retryAfterMs: 120_000 });
    await expect(client.summary(STEAM_ID)).rejects.toThrow('Steam GetPlayerSummaries failed (503)');
    await expect(client.summary(STEAM_ID)).rejects.toThrow(`Steam has no profile with the ID ${STEAM_ID}`);

    // Even if a network error quotes the URL, the key doesn't get through.
    const leaky = (async (url: string | URL) => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error(`connect ECONNREFUSED for ${String(url)}`) });
    }) as typeof globalThis.fetch;
    const err = (await new SteamClient('secret-key', leaky).summary(STEAM_ID).then(
      () => undefined,
      (e: Error) => e,
    ))!;
    expect(err.message).toMatch(/^Could not reach the Steam Web API: connect ECONNREFUSED/);
    expect(err.message).not.toContain('secret-key');
  });
});

describe('Steam store lookups', () => {
  it('caches app details and remembers apps without a store page', async () => {
    const fetch = scriptedFetch([
      { status: 200, body: { '1145360': { success: true, data: { name: 'Hades', header_image: HEADER } } } },
      { status: 200, body: { '480': { success: false } } },
    ]);
    const store = new SteamStore(fetch.impl);
    expect(await store.app('1145360')).toEqual({ name: 'Hades', headerImage: HEADER });
    expect(fetch.calls[0]?.url).toBe('https://store.steampowered.com/api/appdetails?appids=1145360&filters=basic');
    expect(await store.app('480')).toBeNull();
    // Both cached, and concurrent lookups share a request.
    await Promise.all([store.app('1145360'), store.app('480'), store.app('480')]);
    expect(fetch.calls).toHaveLength(2);
  });

  it('pauses every lookup after a failure, as long as Retry-After asks', async () => {
    const fetch = scriptedFetch([
      { status: 429, headers: { 'Retry-After': '1800' } },
      { status: 200, body: { '620': { success: true, data: { name: 'Portal 2', header_image: 'https://cdn.example/620.jpg' } } } },
    ]);
    const store = new SteamStore(fetch.impl);
    expect(await store.app('1145360', 0)).toBeUndefined();
    expect(store.lastError).toBe('Steam store lookup failed (429)');
    expect(await store.app('620', 20 * 60_000)).toBeUndefined(); // still paused: no request
    expect(fetch.calls).toHaveLength(1);
    expect(await store.app('620', 30 * 60_000)).toMatchObject({ name: 'Portal 2' });
    expect(store.lastError).toBeUndefined();
  });
});

// ---- plugin flow, against a fake Steam -----------------------------------------------------------

/** A fake Steam Web API and store, routed by URL. */
function fakeSteam() {
  const s = {
    player: player({ gameid: '1145360', gameextrainfo: 'Hades' }),
    /** Next responses for GetPlayerSummaries, before falling back to `player`. */
    summaryErrors: [] as Array<{ status: number; headers?: Record<string, string> }>,
    calls: [] as string[],
  };
  const impl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const method = url.hostname === 'store.steampowered.com' ? `appdetails ${url.searchParams.get('appids')}` : url.pathname.split('/')[2]!;
    s.calls.push(method);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'store.steampowered.com') {
      const id = url.searchParams.get('appids')!;
      if (id === '1145360') return json({ [id]: { success: true, data: { name: 'Hades', header_image: HEADER } } });
      return json({ [id]: { success: false } });
    }
    if (url.searchParams.get('key') !== 'good-key') return new Response('<html>Forbidden</html>', { status: 403 });
    if (method === 'ResolveVanityURL') {
      return json({ response: url.searchParams.get('vanityurl') === 'tsuni' ? { success: 1, steamid: STEAM_ID } : { success: 42 } });
    }
    const err = s.summaryErrors.shift();
    if (err) return new Response('', { status: err.status, headers: err.headers });
    return json({ response: { players: [s.player] } });
  }) as typeof fetch;
  const count = (method: string) => s.calls.filter((c) => c === method).length;
  return { s, impl, count };
}

const dirs: string[] = [];
const registries: Registry[] = [];
afterEach(async () => {
  for (const r of registries.splice(0)) await r.stopAll();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function boot(config: Record<string, unknown>, opts: { dir?: string; steam?: ReturnType<typeof fakeSteam> } = {}) {
  const steam = opts.steam ?? fakeSteam();
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'srpc-steam-'));
  if (!opts.dir) dirs.push(dir);
  const hub = new Hub();
  const logs = new LogBuffer();
  const registry = new Registry({
    plugins: [createSteamPlugin(steam.impl)],
    config: new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig),
    state: new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({})),
    hub,
    log: new Logger(logs, 'test', 'error'),
    env: { publicUrl: undefined },
  });
  registries.push(registry);
  await registry.ensureInstances([{ plugin: 'steam', enabled: true }]);
  const result = await registry.saveConfig('steam', config);
  expect(result.ok).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  const activity = () => hub.get('steam')?.activity;
  const status = () => registry.get('steam')!.status;
  return { steam, hub, registry, logs, dir, activity, status, count: steam.count };
}

const configured = { apiKey: 'good-key', steamId: 'https://steamcommunity.com/id/tsuni/', storeButton: true };
const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
const flushState = async () => {
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 20)); // let the state file be written
};

describe('steam plugin', () => {
  it('asks for setup when unconfigured, and rejects a bad profile', async () => {
    fake();
    const { registry, status } = await boot({});
    expect(status()).toEqual({ health: 'setup', message: 'Set the Steam Web API key and profile' });
    expect((await registry.saveConfig('steam', { steamId: 'not a profile' })).ok).toBe(false);
  });

  it('publishes the game with store art, resolving the custom URL once', async () => {
    fake();
    const t = await boot(configured);
    expect(t.activity()).toMatchObject({
      key: `steam:${STEAM_ID}:1145360`,
      name: 'Steam',
      title: 'Hades',
      largeImage: { url: HEADER, text: 'Hades' },
      links: [{ label: 'View on Steam', url: 'https://store.steampowered.com/app/1145360/' }],
    });
    expect(t.status()).toEqual({ health: 'ok', message: 'Tsuni is playing Hades' });
    const started = t.activity()!.startedAt;

    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.count('GetPlayerSummaries')).toBe(4);
    expect(t.count('ResolveVanityURL')).toBe(1);
    expect(t.count('appdetails 1145360')).toBe(1);
    expect(t.activity()!.startedAt).toBe(started);

    // The resolved id is kept in state, so a restart doesn't resolve it again.
    await t.registry.restart('steam');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.count('ResolveVanityURL')).toBe(1);
    expect(t.count('appdetails 1145360')).toBe(1); // store cache survives restarts too
    expect(t.activity()!.startedAt).toBe(started); // and the timer keeps running

    t.steam.s.player = player();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.activity()).toBeUndefined();
    expect(t.status()).toEqual({ health: 'idle', message: "Tsuni isn't playing anything." });
    await flushState();
  });

  it('keeps the start time across a process restart, but not from an old session', async () => {
    fake();
    const first = await boot(configured);
    const started = first.activity()!.startedAt!;
    await first.registry.stopAll();
    await flushState();

    // Back a minute later: same session.
    fake();
    vi.setSystemTime(started + 60_000);
    const again = await boot(configured, { dir: first.dir, steam: first.steam });
    expect(again.activity()!.startedAt).toBe(started);
    await again.registry.stopAll();
    await flushState();

    // Back an hour later: the game was relaunched since, so the timer starts over.
    fake();
    vi.setSystemTime(started + 3600_000);
    const later = await boot(configured, { dir: first.dir, steam: first.steam });
    expect(later.activity()!.startedAt).toBe(started + 3600_000);
    await flushState();
  });

  it('shows non-Steam games by name, with the fallback image and no store lookup', async () => {
    fake();
    const steam = fakeSteam();
    steam.s.player = player({ gameid: SHORTCUT_ID, gameextrainfo: 'RetroArch' });
    const t = await boot({ ...configured, steamId: STEAM_ID, fallbackImage: 'steamdeck' }, { steam });
    expect(t.activity()).toMatchObject({ title: 'RetroArch', largeImage: { url: 'steamdeck', text: 'RetroArch' } });
    expect(t.activity()!.links).toBeUndefined();
    expect(steam.s.calls).toEqual(['GetPlayerSummaries']);
    await flushState();
  });

  it("names an app from the store when Steam doesn't, and skips the button without a store page", async () => {
    fake();
    const steam = fakeSteam();
    steam.s.player = player({ gameid: '480' });
    const t = await boot({ ...configured, steamId: STEAM_ID }, { steam });
    expect(t.activity()).toMatchObject({ title: 'Steam app 480' });
    expect(t.activity()!.links).toBeUndefined();
    await flushState();
  });

  it('ignores listed games', async () => {
    fake();
    const t = await boot({ ...configured, ignore: ['hades'] });
    expect(t.activity()).toBeUndefined();
    expect(t.status()).toEqual({ health: 'idle', message: 'Tsuni is playing Hades (ignored)' });
    expect(t.count('appdetails 1145360')).toBe(0);
    await flushState();
  });

  it('warns when the profile is hidden from the key', async () => {
    fake();
    const steam = fakeSteam();
    steam.s.player = player(undefined, { communityvisibilitystate: 1 });
    const t = await boot({ ...configured, steamId: STEAM_ID }, { steam });
    expect(t.status().health).toBe('warning');
    expect(t.status().message).toMatch(/isn't visible to the API key's account/);
  });

  it('backs off after errors, follows Retry-After, and never shows the key', async () => {
    fake();
    const steam = fakeSteam();
    steam.s.summaryErrors.push({ status: 503 }, { status: 503 }, { status: 429, headers: { 'Retry-After': '600' } });
    const t = await boot({ ...configured, steamId: STEAM_ID }, { steam });
    expect(t.count('GetPlayerSummaries')).toBe(1);
    expect(t.status()).toEqual({ health: 'error', message: 'Steam GetPlayerSummaries failed (503)' });
    await vi.advanceTimersByTimeAsync(59_000); // 30 s × 2
    expect(t.count('GetPlayerSummaries')).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.count('GetPlayerSummaries')).toBe(2);
    await vi.advanceTimersByTimeAsync(120_000); // 30 s × 4
    expect(t.count('GetPlayerSummaries')).toBe(3);
    expect(t.status().message).toBe('Steam is rate limiting requests (429)');
    expect(t.activity()).toBeUndefined(); // three failures in a row
    await vi.advanceTimersByTimeAsync(599_000);
    expect(t.count('GetPlayerSummaries')).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.count('GetPlayerSummaries')).toBe(4);
    expect(t.status().health).toBe('ok');
    const errors = t.logs.recent().map((e) => e.message);
    expect(errors).toContain('Steam is rate limiting requests (429)');
    expect(errors.join('\n')).not.toContain('good-key');
    await flushState();
  });

  it('tests the connection from the settings page, and renders the live card', async () => {
    fake();
    const t = await boot(configured);
    const app = createWebApp({ registry: t.registry, hub: t.hub, logs: t.logs, env: { publicUrl: undefined }, uiPassword: undefined });
    const res = await app.request('/plugins/steam/test', { method: 'POST', headers: { Origin: 'http://localhost' } });
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('Connected to Steam as Tsuni, playing Hades.');
    const page = await (await app.request('/instances/steam')).text();
    expect(page).toContain('Test connection');
    expect(page).not.toContain('good-key');
    const live = await (await app.request('/instances/steam/live')).text();
    expect(live).toContain(HEADER.replace(/&/g, '&amp;'));
    expect(live).toContain('Published: Steam · Hades · artwork: store');
    await flushState();
  });

  it('reports a rejected key', async () => {
    fake();
    const t = await boot({ apiKey: 'wrong-key', steamId: STEAM_ID });
    expect(t.status()).toEqual({ health: 'error', message: 'Steam rejected the Web API key' });
  });
});
