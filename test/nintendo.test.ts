import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { emptyConfig, Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore } from '../src/core/store.js';
import {
  describeError,
  NintendoAuthError,
  NintendoError,
  parseAppLink,
  parseRetryAfter,
  type FriendInfo,
  type NintendoBackend,
  type PendingLogin,
} from '../src/plugins/nintendo/client.js';
import { createNintendoPlugin } from '../src/plugins/nintendo/index.js';
import { formatPlayTime, toNowPlaying } from '../src/plugins/nintendo/presence.js';
import { createWebApp } from '../src/web/app.js';

const main = (state: string, game?: Partial<NonNullable<FriendInfo['presence']['game']>>, platform = 2): FriendInfo => ({
  nsaId: 'main-nsa',
  name: 'Tsuni',
  imageUri: 'https://cdn.example/avatar.png',
  presence: {
    state,
    updatedAt: Math.floor(Date.now() / 1000) - 600,
    platform,
    game: game ? { name: 'Splatoon 3', imageUri: 'https://atum.example/s3.jpg', shopUri: 'https://ec.nintendo.com/apps/0100c2500fc20000/US', totalPlayTime: 6000, sysDescription: '', ...game } : undefined,
  },
});

const opts = { activityName: '', titleTemplate: '{game}', subtitleTemplate: '[{description}]', smallImage: '', eshopButton: false };

describe('Switch presence mapping', () => {
  it('maps a game, naming the console', () => {
    expect(toNowPlaying(main('ONLINE', {}), opts, 1000)).toEqual({
      key: 'nintendo:main-nsa:Splatoon 3',
      kind: 'playing',
      name: 'Nintendo Switch 2',
      title: 'Splatoon 3',
      startedAt: 1000,
      largeImage: { url: 'https://atum.example/s3.jpg', text: 'Splatoon 3' },
    });
    expect(toNowPlaying(main('PLAYING', {}, 1), opts, 1000)?.name).toBe('Nintendo Switch');
  });

  it('uses templates, the game status text and the eShop button', () => {
    const a = toNowPlaying(main('PLAYING', { sysDescription: 'Turf War' }), {
      ...opts,
      activityName: 'Switch',
      subtitleTemplate: '[{description}] · [{online}]',
      eshopButton: true,
      smallImage: 'switch',
    }, 1000);
    expect(a).toMatchObject({
      name: 'Switch',
      subtitle: 'Turf War · Playing online',
      smallImage: { url: 'switch', text: 'Nintendo Switch 2' },
      links: [{ label: 'Nintendo eShop', url: 'https://ec.nintendo.com/apps/0100c2500fc20000/US' }],
    });
  });

  it('shows nothing when offline, idle on the console, or without a game', () => {
    expect(toNowPlaying(main('OFFLINE'), opts, 1000)).toBeNull();
    expect(toNowPlaying(main('INACTIVE'), opts, 1000)).toBeNull();
    expect(toNowPlaying(main('ONLINE'), opts, 1000)).toBeNull();
  });

  it('formats play time', () => {
    expect(formatPlayTime(0)).toBe('');
    expect(formatPlayTime(1)).toBe('1 minute');
    expect(formatPlayTime(59)).toBe('59 minutes');
    expect(formatPlayTime(6000)).toBe('100 hours');
  });

  it('parses the "Select this person" link', () => {
    expect(parseAppLink('npf71b963c1b7b6d119://auth#session_token_code=abc&state=xyz&session_state=s').get('session_token_code')).toBe('abc');
    expect(() => parseAppLink('https://accounts.nintendo.com/')).toThrow(/Select this person/);
  });
});

// ---- plugin flow with a fake backend -------------------------------------------------------------

class FakeBackend implements NintendoBackend {
  calls: string[] = [];
  friendList: FriendInfo[] = [main('ONLINE', {})];
  failWith: Error | undefined;
  async beginLogin(): Promise<PendingLogin> {
    this.calls.push('beginLogin');
    return { url: 'https://accounts.nintendo.com/connect/1.0.0/authorize?x', state: 's', verifier: 'v', createdAt: Date.now() };
  }
  async completeLogin(_pending: PendingLogin, link: string) {
    this.calls.push(`completeLogin ${link}`);
    parseAppLink(link);
    return { sessionToken: 'na-session', auth: { fake: true } as never, accountName: 'Alt', friends: this.friendList };
  }
  connect() {
    this.calls.push('connect');
    return {
      friends: async () => {
        this.calls.push('friends');
        if (this.failWith) throw this.failWith;
        return this.friendList;
      },
    };
  }
}

const dirs: string[] = [];
const registries: Registry[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const r of registries.splice(0)) await r.stopAll();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function boot() {
  const backend = new FakeBackend();
  const plugin = createNintendoPlugin(() => backend);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srpc-nintendo-'));
  dirs.push(dir);
  const hub = new Hub();
  const logs = new LogBuffer();
  const registry = new Registry({
    plugins: [plugin],
    config: new JsonStore<AppConfig>(path.join(dir, 'config.json'), emptyConfig),
    state: new JsonStore<Record<string, unknown>>(path.join(dir, 'state.json'), () => ({})),
    hub,
    log: new Logger(logs, 'test', 'error'),
    env: { publicUrl: undefined },
  });
  registries.push(registry);
  await registry.ensureInstances([{ plugin: 'nintendo', enabled: true }]);
  await registry.saveConfig('nintendo', { clientId: 'test-client' });
  const app = createWebApp({ registry, hub, logs, env: { publicUrl: undefined }, uiPassword: undefined });
  const post = (p: string, body: Record<string, string> = {}) =>
    app.request(p, {
      method: 'POST',
      body: new URLSearchParams(body),
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  const page = async () => (await app.request('/instances/nintendo')).text();
  const fetches = () => backend.calls.filter((c) => c === 'friends').length;
  return { backend, hub, registry, post, page, fetches, status: () => registry.get('nintendo')!.status };
}

/** Boot with the notice accepted, signed in and showing the main account. */
async function bootWatching() {
  const t = await boot();
  await t.post('/plugins/nintendo/consent', { ack: 'on' });
  await t.post('/plugins/nintendo/login');
  await t.post('/plugins/nintendo/login/finish', { link: 'npf71b963c1b7b6d119://auth#session_token_code=c&state=s' });
  await t.post('/plugins/nintendo/friend', { nsaId: 'main-nsa' });
  return t;
}

const responseError = (url: string, status: number, data?: object, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Non-200 status code`), { response: { status, url, headers: new Headers(headers) }, data });

describe('Nintendo error classification', () => {
  it('retries network errors with backoff', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') });
    expect(describeError(err)).toMatchObject({ message: 'Network error: connect ECONNREFUSED', retry: { kind: 'backoff' } });
    expect(describeError(new Error('Timeout')).retry).toEqual({ kind: 'backoff' });
  });

  it("follows nxapi-znca-api's Retry-After, and otherwise doesn't retry it", () => {
    const znca = 'https://nxapi-znca-api.fancy.org.uk/api/znca/encrypt-request';
    expect(describeError(responseError(znca, 429, { error: 'rate_limit' }, { 'Retry-After': '120' }))).toMatchObject({
      message: 'nxapi-znca-api error: rate_limit',
      retry: { kind: 'after', ms: 120_000 },
    });
    expect(describeError(responseError(znca, 401, { error: 'invalid_client' })).retry).toEqual({ kind: 'none' });
  });

  it('never retries Nintendo, and signs out only on its invalid_grant', () => {
    const nintendo = describeError(responseError('https://api-lp1.znc.srv.nintendo.net/v4/Friend/List', 503, undefined, { 'Retry-After': '5' }));
    expect(nintendo.retry).toEqual({ kind: 'none' });
    const grant = describeError(responseError('https://accounts.nintendo.com/connect/1.0.0/api/token', 400, { error: 'invalid_grant' }));
    expect(grant).toBeInstanceOf(NintendoAuthError);
    expect((grant as NintendoAuthError).signInAgain).toBe(true);
    const other = describeError(responseError('https://nxapi-auth.fancy.org.uk/api/oauth/token', 400, { error: 'invalid_grant' }));
    expect(other).not.toBeInstanceOf(NintendoAuthError);
  });

  it('parses Retry-After', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', Date.parse('2026-01-01T00:00:00Z'))).toBe(60_000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('nintendo plugin', () => {
  it('requires the notice to be acknowledged before contacting anything', async () => {
    const t = await boot();
    expect(t.status().message).toBe('Read and accept the notice to sign in');
    expect(await t.page()).toContain('will be sent to nxapi-znca-api');

    const early = await t.post('/plugins/nintendo/login');
    expect(early.headers.get('location')).toContain('error=');
    expect((await t.post('/plugins/nintendo/consent')).headers.get('location')).toContain('error='); // box not ticked
    expect(t.backend.calls).toEqual([]);

    await t.post('/plugins/nintendo/consent', { ack: 'on' });
    expect(t.status().message).toBe('Sign in with your secondary Nintendo Account');
  });

  it('signs in, picks a friend and publishes their game', async () => {
    const t = await boot();
    await t.post('/plugins/nintendo/consent', { ack: 'on' });
    await t.post('/plugins/nintendo/login');
    expect(await t.page()).toContain('https://accounts.nintendo.com/connect/1.0.0/authorize?x');

    const bad = await t.post('/plugins/nintendo/login/finish', { link: 'https://wrong' });
    expect(decodeURIComponent(bad.headers.get('location') ?? '')).toMatch(/Select this person/);

    await t.post('/plugins/nintendo/login/finish', { link: 'npf71b963c1b7b6d119://auth#session_token_code=c&state=s' });
    expect(t.status().message).toBe('Choose the friend to show');
    expect(await t.page()).toContain('Signed in as Alt');

    await t.post('/plugins/nintendo/friend', { nsaId: 'main-nsa' });
    expect(t.hub.get('nintendo')?.activity).toMatchObject({ title: 'Splatoon 3', name: 'Nintendo Switch 2' });
    expect(t.status()).toEqual({ health: 'ok', message: 'Tsuni is playing Splatoon 3' });

    // A rejected session token signs out instead of retrying.
    t.backend.failWith = new NintendoAuthError('Nintendo no longer accepts this sign-in; sign in again.', true);
    await t.post('/plugins/nintendo/friends/refresh');
    expect(t.status().message).toMatch(/sign in again/);
    expect(t.hub.get('nintendo')).toBeUndefined();
  });

  it('reuses the friend list from sign-in, Refresh and before a restart', async () => {
    const t = await bootWatching();
    expect(t.fetches()).toBe(0); // signing in fetched it, as the app does
    await t.registry.restart('nintendo');
    expect(t.fetches()).toBe(0);
    expect(t.hub.get('nintendo')?.activity).toMatchObject({ title: 'Splatoon 3' });
    await t.post('/plugins/nintendo/friends/refresh');
    expect(t.fetches()).toBe(1);
  });

  it('polls once the cached list is a poll interval old', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t = await bootWatching();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(t.fetches()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.fetches()).toBe(1);
  });

  it('backs off after network errors and follows Retry-After', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t = await bootWatching();
    t.backend.failWith = new NintendoError('Network error: connect ECONNREFUSED', { kind: 'backoff' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetches()).toBe(1);
    expect(t.status()).toEqual({ health: 'error', message: 'Network error: connect ECONNREFUSED' });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(t.fetches()).toBe(1);
    t.backend.failWith = new NintendoError('nxapi-znca-api error: rate_limit', { kind: 'after', ms: 5_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.fetches()).toBe(2);
    t.backend.failWith = undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.fetches()).toBe(3);
    expect(t.status().health).toBe('ok');
  });

  it('stops polling after an error it may not retry, until Try again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t = await bootWatching();
    t.backend.failWith = new NintendoError('nxapi-znca-api error: invalid_client', { kind: 'none' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetches()).toBe(1);
    expect(t.status().message).toMatch(/invalid_client\. Stopped checking until you choose Try again/);
    expect(t.hub.get('nintendo')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(t.fetches()).toBe(1);
    expect(await t.page()).toContain('Try again');

    t.backend.failWith = undefined;
    await t.post('/plugins/nintendo/friends/refresh');
    expect(t.fetches()).toBe(2);
    expect(t.status().health).toBe('ok');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetches()).toBe(3);
  });

  it('signs out when a poll finds the session token rejected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t = await bootWatching();
    t.backend.failWith = new NintendoAuthError('Nintendo no longer accepts this sign-in; sign in again.', true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.status().message).toMatch(/sign in again/);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(t.fetches()).toBe(1);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20)); // let the state file be written
  });

  it('signing out deletes the tokens', async () => {
    const t = await boot();
    await t.post('/plugins/nintendo/consent', { ack: 'on' });
    await t.post('/plugins/nintendo/login');
    await t.post('/plugins/nintendo/login/finish', { link: 'npf71b963c1b7b6d119://auth#session_token_code=c&state=s' });
    await t.post('/plugins/nintendo/signout');
    const state = t.registry.get('nintendo')!;
    expect(state.status.message).toBe('Sign in with your secondary Nintendo Account');
  });
});
