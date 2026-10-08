import { describe, expect, it } from 'vitest';
import { activitiesEquivalent } from '../src/core/activity.js';
import { Hub } from '../src/core/hub.js';
import { movie } from './helpers.js';

describe('activitiesEquivalent', () => {
  it('ignores timestamp jitter within the tolerance', () => {
    expect(activitiesEquivalent(movie(), movie({ startedAt: 1_003_000, endsAt: 9_004_000 }))).toBe(true);
  });

  it('treats a seek beyond the tolerance as a change', () => {
    expect(activitiesEquivalent(movie(), movie({ endsAt: 9_060_000 }))).toBe(false);
  });

  it('notices added or removed timestamps', () => {
    expect(activitiesEquivalent(movie(), movie({ endsAt: undefined }))).toBe(false);
  });

  it('compares other fields exactly, regardless of key order or undefined members', () => {
    expect(activitiesEquivalent(movie({ paused: undefined }), { ...movie() })).toBe(true);
    expect(activitiesEquivalent(movie(), movie({ paused: true }))).toBe(false);
    expect(activitiesEquivalent(movie(), movie({ largeImage: { url: 'https://x/y.jpg' } }))).toBe(false);
  });

  it('handles nulls', () => {
    expect(activitiesEquivalent(null, undefined)).toBe(true);
    expect(activitiesEquivalent(movie(), null)).toBe(false);
  });
});

describe('Hub', () => {
  it('emits only on real changes and tracks changedAt', () => {
    let now = 100;
    const hub = new Hub(() => now);
    const seen: number[] = [];
    hub.subscribe((s) => seen.push(s.activities.length));

    hub.set('a', movie());
    now = 200;
    hub.set('a', movie()); // identical: no event
    hub.set('b', null); // nothing to remove: no event
    hub.set('a', movie({ paused: true }));
    hub.set('a', null);

    expect(seen).toEqual([1, 1, 0]);
    hub.set('a', movie());
    expect(hub.get('a')?.changedAt).toBe(200);
  });
});
