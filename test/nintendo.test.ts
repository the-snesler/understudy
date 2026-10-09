import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/core/hub.js';
import { LogBuffer, Logger } from '../src/core/log.js';
import { emptyConfig, Registry, type AppConfig } from '../src/core/registry.js';
import { JsonStore } from '../src/core/store.js';
import {
  NintendoAuthError,
  parseAppLink,
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
    return { sessionToken: 'na-session', auth: { fake: true } as never, accountName: 'Alt' };
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
  return { backend, hub, registry, post, page, status: () => registry.get('nintendo')!.status };
}

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
    await t.registry.restart('nintendo');
    await new Promise((r) => setTimeout(r, 20));
    expect(t.status().message).toMatch(/sign in again/);
    expect(t.hub.get('nintendo')).toBeUndefined();
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
