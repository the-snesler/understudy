import { describe, expect, it } from 'vitest';
import { DiscordApi, DiscordApiError } from '../src/plugins/discord/api.js';
import { HeadlessSession, type DiscordActivity } from '../src/plugins/discord/headless.js';
import { buildAuthorizeUrl, parseCallbackInput, pkceChallenge } from '../src/plugins/discord/oauth.js';
import { quietLogger, scriptedFetch } from './helpers.js';

const activity: DiscordActivity = {
  application_id: '1',
  platform: 'desktop',
  supported_platforms: ['desktop'],
  type: 3,
  name: 'Plex',
};

function setup(responses: Parameters<typeof scriptedFetch>[0], initialToken?: string) {
  const fetch = scriptedFetch(responses);
  const slept: number[] = [];
  let refreshes = 0;
  const api = new DiscordApi({
    apiBase: 'https://discord.test/api/v10',
    log: quietLogger(),
    fetchImpl: fetch.impl,
    sleep: async (ms) => void slept.push(ms),
    now: () => 0,
    tokens: {
      accessToken: async () => 'access-1',
      forceRefresh: async () => `access-${++refreshes + 1}`,
    },
  });
  let saved: string | undefined = initialToken;
  const session = new HeadlessSession(api, { load: () => saved, save: async (t) => void (saved = t) }, quietLogger());
  return { session, calls: fetch.calls, slept, saved: () => saved };
}

describe('HeadlessSession', () => {
  it('creates, then updates with the rotated token each time', async () => {
    const t = setup([
      { status: 200, body: { token: 'tok-1' } },
      { status: 200, body: { token: 'tok-2' } },
      { status: 200, body: { token: 'tok-3' } },
    ]);
    await t.session.upsert(activity);
    await t.session.upsert(activity);
    await t.session.upsert(activity);
    expect(t.calls.map((c) => (c.body as { token?: string }).token)).toEqual([undefined, 'tok-1', 'tok-2']);
    expect(t.saved()).toBe('tok-3');
  });

  it('recreates the session when Discord rejects the token (50014)', async () => {
    const t = setup(
      [
        { status: 400, body: { message: 'Invalid authentication token', code: 50014 } },
        { status: 200, body: { token: 'fresh' } },
      ],
      'stale',
    );
    await t.session.upsert(activity);
    expect(t.calls.map((c) => (c.body as { token?: string }).token)).toEqual(['stale', undefined]);
    expect(t.saved()).toBe('fresh');
  });

  it('does not drop the token on other 400s', async () => {
    const t = setup([{ status: 400, body: { message: 'Invalid Form Body', code: 50035 } }], 'good');
    await expect(t.session.upsert(activity)).rejects.toBeInstanceOf(DiscordApiError);
    expect(t.saved()).toBe('good');
  });

  it('deletes, tolerating an already-gone session, and serialises calls', async () => {
    const t = setup([
      { status: 200, body: { token: 'tok-1' } },
      { status: 404, body: { message: 'Unknown session' } },
    ]);
    // Fire both without awaiting: the delete must still run after the create, with its token.
    const a = t.session.upsert(activity);
    const b = t.session.clear();
    await Promise.all([a, b]);
    expect(t.calls.map((c) => c.url.split('/v10')[1])).toEqual([
      '/users/@me/headless-sessions',
      '/users/@me/headless-sessions/delete',
    ]);
    expect(t.calls[1]?.body).toEqual({ token: 'tok-1' });
    expect(t.session.active).toBe(false);
  });
});

describe('DiscordApi', () => {
  it('waits and retries on 429', async () => {
    const t = setup([
      { status: 429, body: { message: 'You are being rate limited.', retry_after: 4.5, global: false } },
      { status: 200, body: { token: 'ok' } },
    ]);
    await t.session.upsert(activity);
    expect(t.slept).toEqual([4500]);
    expect(t.saved()).toBe('ok');
  });

  it('waits when the bucket is exhausted', async () => {
    const t = setup([
      { status: 200, body: { token: 'a' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '7.25' } },
      { status: 200, body: { token: 'b' } },
    ]);
    await t.session.upsert(activity);
    expect(t.slept).toEqual([]);
    await t.session.upsert(activity);
    expect(t.slept).toEqual([7250]);
  });

  it('refreshes the access token once on 401', async () => {
    const t = setup([
      { status: 401, body: { message: '401: Unauthorized' } },
      { status: 200, body: { token: 'ok' } },
    ]);
    await t.session.upsert(activity);
    expect(t.saved()).toBe('ok');
  });
});

describe('oauth helpers', () => {
  it('computes the RFC 7636 example challenge', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('builds the authorize URL with the presence scopes', () => {
    const url = new URL(
      buildAuthorizeUrl({
        endpoints: { authorizeUrl: 'https://discord.com/oauth2/authorize', apiBase: '' },
        clientId: '123',
        redirectUri: 'http://localhost:8080/plugins/discord/callback',
        state: 's',
        challenge: 'c',
      }),
    );
    expect(url.searchParams.get('scope')).toBe('openid sdk.social_layer_presence');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8080/plugins/discord/callback');
  });

  it('parses pasted callback URLs, bare codes and errors', () => {
    expect(parseCallbackInput('http://localhost:8080/plugins/discord/callback?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseCallbackInput('  abc_DEF-123 ')).toEqual({ code: 'abc_DEF-123' });
    expect(parseCallbackInput('http://x/cb?error=invalid_scope&error_description=bad').error).toBe('invalid_scope: bad');
    expect(parseCallbackInput('not a url at all')).toEqual({});
  });
});
