import { describe, expect, it } from 'vitest';
import { toDiscordActivity } from '../src/plugins/discord/mapping.js';
import { pick, type PublisherConfig } from '../src/plugins/discord/publisher.js';
import { movie } from './helpers.js';

const opts = { applicationId: '1557839419422285984', statusDisplay: 'details' as const };

describe('toDiscordActivity', () => {
  it('maps a playing movie', () => {
    const a = toDiscordActivity(
      movie({
        largeImage: { url: 'https://image.tmdb.org/t/p/w500/x.jpg', text: 'The Matrix' },
        links: [{ label: 'IMDb', url: 'https://www.imdb.com/title/tt0133093/' }],
      }),
      opts,
    );
    expect(a).toEqual({
      application_id: '1557839419422285984',
      platform: 'desktop',
      supported_platforms: ['desktop'],
      type: 3,
      name: 'Plex',
      details: 'The Matrix (1999)',
      state: 'Sci-Fi',
      status_display_type: 2,
      timestamps: { start: '1000000', end: '9000000' },
      assets: { large_image: 'https://image.tmdb.org/t/p/w500/x.jpg', large_text: 'The Matrix' },
      buttons: [{ label: 'IMDb', url: 'https://www.imdb.com/title/tt0133093/' }],
    });
  });

  it('drops timestamps and marks the state when paused', () => {
    const a = toDiscordActivity(movie({ paused: true }), opts);
    expect(a.timestamps).toBeUndefined();
    expect(a.state).toBe('Sci-Fi · Paused');
    expect(toDiscordActivity(movie({ paused: true, subtitle: undefined }), opts).state).toBe('Paused');
  });

  it('maps kinds and status display', () => {
    expect(toDiscordActivity(movie({ kind: 'listening' }), opts).type).toBe(2);
    expect(toDiscordActivity(movie({ kind: 'playing' }), opts).type).toBe(0);
    expect(toDiscordActivity(movie(), { ...opts, statusDisplay: 'name' }).status_display_type).toBe(0);
    expect(toDiscordActivity(movie(), { ...opts, statusDisplay: 'state' }).status_display_type).toBe(1);
  });

  it('enforces Discord field limits', () => {
    const a = toDiscordActivity(
      movie({
        title: 'x'.repeat(200),
        subtitle: 'y',
        largeImage: { url: `https://example.com/${'a'.repeat(400)}` },
        smallImage: { url: 'http://insecure.example/x.png' },
        links: [
          { label: 'A label that is far too long for a Discord button', url: 'https://a.example' },
          { label: 'not https', url: 'http://b.example' },
          { label: 'B', url: 'https://b.example' },
          { label: 'C', url: 'https://c.example' },
        ],
      }),
      opts,
    );
    expect(a.details).toHaveLength(128);
    expect(a.details?.endsWith('…')).toBe(true);
    expect(a.state).toBe('y '); // 1-char strings are rejected by Discord
    expect(a.assets).toBeUndefined();
    expect(a.buttons?.map((b) => b.url)).toEqual(['https://a.example', 'https://b.example']);
    expect(a.buttons?.[0]?.label).toHaveLength(32);
  });
});

describe('pick', () => {
  const config: PublisherConfig = {
    applicationId: '1',
    sourcePriority: ['plex', 'switch'],
    paused: 'last',
    statusDisplay: 'details',
    refreshMinutes: 5,
  };
  const sources = ['plex', 'switch', 'other'].map((id) => ({ id, label: id, enabled: true }));
  const entry = (sourceId: string, changedAt: number, paused = false) => ({
    sourceId,
    changedAt,
    activity: movie({ key: sourceId, paused }),
  });

  it('follows the priority list, then recency', () => {
    const state = { activities: [entry('other', 300), entry('switch', 200), entry('plex', 100)] };
    expect(pick(state, config, sources)?.sourceId).toBe('plex');
    expect(pick({ activities: [entry('other', 300), entry('switch', 200)] }, config, sources)?.sourceId).toBe('switch');
    expect(pick(state, { ...config, sourcePriority: [] }, sources)?.sourceId).toBe('other');
  });

  it('hides, ranks last, or shows paused activities', () => {
    const state = { activities: [entry('plex', 100, true), entry('switch', 50)] };
    expect(pick(state, config, sources)?.sourceId).toBe('switch');
    expect(pick(state, { ...config, paused: 'show' }, sources)?.sourceId).toBe('plex');
    expect(pick(state, { ...config, paused: 'hide' }, sources)?.sourceId).toBe('switch');
    const onlyPaused = { activities: [entry('plex', 100, true)] };
    expect(pick(onlyPaused, config, sources)?.sourceId).toBe('plex');
    expect(pick(onlyPaused, { ...config, paused: 'hide' }, sources)).toBeNull();
  });

  it('ignores disabled sources', () => {
    const state = { activities: [entry('plex', 100)] };
    expect(pick(state, config, [{ id: 'plex', label: 'plex', enabled: false }])).toBeNull();
  });
});
