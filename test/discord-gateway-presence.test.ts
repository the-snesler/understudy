import { describe, expect, it } from 'vitest';
import { DiscordApi } from '../src/plugins/discord/api.js';
import { GatewayPresence } from '../src/plugins/discord/gateway-presence.js';
import type { DiscordGateway, GatewayActivity } from '../src/plugins/discord/gateway.js';
import type { DiscordActivity } from '../src/plugins/discord/headless.js';
import { quietLogger, scriptedFetch } from './helpers.js';

const POSTER = 'https://image.tmdb.org/t/p/w500/x.jpg';

function setup(responses: Parameters<typeof scriptedFetch>[0]) {
  const fetch = scriptedFetch(responses);
  const api = new DiscordApi({
    apiBase: 'https://discord.test/api/v10',
    log: quietLogger(),
    fetchImpl: fetch.impl,
    tokens: { accessToken: async () => 'a', forceRefresh: async () => 'b' },
  });
  let current: GatewayActivity | null = null;
  const gateway = {
    get showing() {
      return current !== null;
    },
    setActivity: (a: GatewayActivity | null) => void (current = a),
  } as unknown as DiscordGateway;
  return { presence: new GatewayPresence(gateway, api, '123', quietLogger()), calls: fetch.calls, current: () => current };
}

const activity: DiscordActivity = {
  application_id: '123',
  platform: 'desktop',
  supported_platforms: ['desktop'],
  type: 3,
  name: 'Plex',
  details: 'The Matrix (1999)',
  state: 'Sci-Fi',
  status_display_type: 2,
  timestamps: { start: '1000', end: '9000' },
  assets: { large_image: POSTER, large_text: 'The Matrix', small_image: 'plex', small_text: 'Plex' },
  buttons: [{ label: 'IMDb', url: 'https://www.imdb.com/title/tt0133093/' }],
};

describe('GatewayPresence', () => {
  it('converts to the Gateway activity shape, proxying external images once', async () => {
    const t = setup([{ status: 200, body: [{ url: POSTER, external_asset_path: 'external/abc/https/image.tmdb.org/t/p/w500/x.jpg' }] }]);
    await t.presence.upsert(activity);
    expect(t.current()).toEqual({
      type: 3,
      name: 'Plex',
      application_id: '123',
      details: 'The Matrix (1999)',
      state: 'Sci-Fi',
      status_display_type: 2,
      timestamps: { start: 1000, end: 9000 },
      assets: { large_image: 'mp:external/abc/https/image.tmdb.org/t/p/w500/x.jpg', large_text: 'The Matrix', small_image: 'plex', small_text: 'Plex' },
      buttons: ['IMDb'],
      metadata: { button_urls: ['https://www.imdb.com/title/tt0133093/'] },
    });
    expect(t.calls[0]).toMatchObject({ method: 'POST', url: 'https://discord.test/api/v10/applications/123/external-assets', body: { urls: [POSTER] } });
    expect(t.presence.active).toBe(true);

    await t.presence.upsert(activity); // cached: no second request
    expect(t.calls).toHaveLength(1);

    await t.presence.clear();
    expect(t.current()).toBeNull();
    expect(t.presence.active).toBe(false);
  });

  it('drops images it could not register rather than failing', async () => {
    const t = setup([{ status: 403, body: { message: 'Missing Access', code: 50001 } }]);
    await t.presence.upsert(activity);
    expect(t.current()?.assets).toEqual({ small_image: 'plex', small_text: 'Plex' });
  });
});
