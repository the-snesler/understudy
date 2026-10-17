import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NowPlaying, SourceActivity } from '../src/core/activity.js';
import { HistoryStore, unionDuration, zonedDayBounds } from '../src/core/history.js';
import type { HistoryReader } from '../src/core/plugin.js';
import { groupSegments } from '../src/core/timeline.js';
import { historyCalendar } from '../src/plugins/feeds/calendar.js';
import { foldCalendarLine } from '../src/plugins/feeds/ics.js';

const stores: HistoryStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-history-'));
  dirs.push(dir);
  return path.join(dir, 'history.sqlite');
}

function history(now: () => number, database = ':memory:', retentionDays?: number): HistoryStore {
  const store = new HistoryStore(database, { now, retentionDays, heartbeatIntervalMs: 0 });
  stores.push(store);
  return store;
}

const activity = (values: Partial<NowPlaying> = {}): NowPlaying => ({
  key: 'movie:1', kind: 'watching', name: 'Plex', title: 'A movie', ...values,
});
const shown = (values: Partial<NowPlaying> = {}, sourceId = 'plex'): SourceActivity => ({
  sourceId, activity: activity(values), changedAt: 0,
});

describe('persistent activity history', () => {
  it('records content and pause transitions independently for every source', () => {
    let now = 100;
    const store = history(() => now);
    store.recordSource('plex', activity());
    store.recordSource('switch', activity({ kind: 'playing', title: 'Zelda', key: 'game:1' }));
    now = 200;
    store.recordSource('plex', activity({ startedAt: 123, endsAt: 456, largeImage: { url: 'https://example.test/art.jpg' } }));
    expect(store.query({ scope: 'source' })).toHaveLength(2);
    now = 300;
    store.recordSource('plex', activity({ paused: true }));
    now = 400;
    store.recordSource('plex', activity({ title: 'Another movie', key: 'movie:2' }));
    now = 500;
    store.recordSource('plex', null);
    store.recordSource('absent', null);
    expect(store.query({ sourceId: 'plex' }).map(({ startedAt, endedAt, paused, key }) => ({ startedAt, endedAt, paused, key }))).toEqual([
      { startedAt: 100, endedAt: 300, paused: false, key: 'movie:1' },
      { startedAt: 300, endedAt: 400, paused: true, key: 'movie:1' },
      { startedAt: 400, endedAt: 500, paused: false, key: 'movie:2' },
    ]);
    expect(store.query({ sourceId: 'switch' })[0]?.endedAt).toBeNull();
  });

  it('records what outputs confirm, including source switches for matching content', () => {
    let now = 100;
    const store = history(() => now);
    store.recordSource('plex', activity());
    expect(store.query({ scope: 'output' })).toHaveLength(0);
    now = 200;
    store.recordShown('discord', shown());
    now = 300;
    store.recordShown('discord', shown({ startedAt: 9_000, smallImage: { url: 'https://example.test/new' } }));
    now = 400;
    store.recordShown('discord', shown({}, 'jellyfin'));
    now = 500;
    store.recordShown('discord', null);
    const output = store.query({ scope: 'output' });
    expect(output.map(({ sourceId, outputId, startedAt, endedAt }) => ({ sourceId, outputId, startedAt, endedAt }))).toEqual([
      { sourceId: 'plex', outputId: 'discord', startedAt: 200, endedAt: 400 },
      { sourceId: 'jellyfin', outputId: 'discord', startedAt: 400, endedAt: 500 },
    ]);
  });

  it('closes interrupted source and output segments at the heartbeat, without recording downtime', () => {
    let now = 100;
    const database = file();
    const first = history(() => now, database);
    first.recordSource('plex', activity());
    first.recordShown('discord', shown());
    now = 300;
    first.heartbeat();
    first.close();
    // The persisted snapshot of an abruptly stopped process has open rows and its last heartbeat.
    const snapshot = new DatabaseSync(database);
    snapshot.exec('UPDATE history_segments SET ended_at = NULL');
    snapshot.close();
    now = 10_000;
    const second = history(() => now, database);
    expect(second.query().map((segment) => segment.endedAt)).toEqual([300, 300]);
    second.recordSource('plex', activity());
    expect(second.query({ scope: 'source' }).map(({ startedAt, endedAt }) => ({ startedAt, endedAt }))).toEqual([
      { startedAt: 100, endedAt: 300 },
      { startedAt: 10_000, endedAt: null },
    ]);
  });

  it('retains partial overlaps and open activity while deleting expired source/output rows', () => {
    let now = 0;
    const store = history(() => now, ':memory:', 90);
    store.recordSource('plex', activity());
    store.recordShown('discord', shown());
    now = 60_000;
    store.recordSource('plex', null);
    store.recordShown('discord', null);
    now = 23 * 3_600_000;
    store.recordSource('switch', activity({ kind: 'playing' }));
    now = 25 * 3_600_000;
    store.recordSource('switch', null);
    store.recordSource('music', activity({ kind: 'listening' }));
    now = 48 * 3_600_000;
    store.setRetention(1);
    expect(store.query().map((item) => item.sourceId)).toEqual(['switch', 'music']);
    expect(() => store.setRetention(0)).toThrow(/positive whole/);
  });

  it('creates private SQLite files and migrates version 0 databases, keeping the old feed token', () => {
    const database = file();
    const old = new DatabaseSync(database);
    old.exec(`
      CREATE TABLE history_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE history_segments (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, output_id TEXT, activity_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('playing', 'watching', 'listening')), title TEXT NOT NULL, subtitle TEXT,
        started_at INTEGER NOT NULL, ended_at INTEGER, paused INTEGER NOT NULL CHECK (paused IN (0, 1))
      ) STRICT;
      CREATE UNIQUE INDEX history_open_source ON history_segments(source_id) WHERE ended_at IS NULL AND output_id IS NULL;
      INSERT INTO history_meta VALUES ('feed_token', 'legacy-token'), ('last_seen', '150');
      INSERT INTO history_segments VALUES ('old', 'plex', NULL, 'm', 'watching', 'Old movie', NULL, 100, NULL, 0);
    `);
    old.close();
    const store = history(() => 200, database);
    expect(fs.statSync(database).mode & 0o777).toBe(0o600);
    expect(store.legacyFeedToken()).toBe('legacy-token');
    expect(store.query()).toEqual([expect.objectContaining({ id: 'old', endedAt: 150 })]);
    // The new kind is accepted after the migration.
    store.importEntries('ical', 'calendar', { from: 0, to: 300 }, [{ uid: 'e', title: 'Lecture', startedAt: 160, endedAt: 190 }]);
    expect(store.query({ sourceId: 'ical' })).toEqual([expect.objectContaining({ kind: 'event', origin: 'calendar' })]);
    expect(history(() => 300).legacyFeedToken()).toBeUndefined();
  });

  it('keeps several observations open per history source and ends only those that disappear', () => {
    let now = 1_000;
    const store = history(() => now);
    const game = { key: 'game', kind: 'playing' as const, title: 'Hades II' };
    const song = { key: 'song', kind: 'listening' as const, title: 'Song', subtitle: 'Artist' };
    store.observe('discord-status', 'discord', [game, song]);
    now = 2_000;
    store.observe('discord-status', 'discord', [game]);
    now = 3_000;
    store.observe('discord-status', 'discord', [game]);
    store.recordSource('plex', activity());
    expect(store.query({ sourceId: 'discord-status' }).map((item) => [item.title, item.startedAt, item.endedAt, item.origin]).sort())
      .toEqual([['Hades II', 1_000, null, 'discord'], ['Song', 1_000, 2_000, 'discord']]);
    expect(store.query({ scope: 'source', excludeOrigins: ['discord'] }).map((item) => item.sourceId)).toEqual(['plex']);
    expect(store.today('UTC', 3_000).playing).toBe(2_000);
    store.close(4_000);
  });

  it('imports entries idempotently, updating in place and removing those gone from the window', () => {
    const now = 10 * 86_400_000;
    const store = history(() => now, ':memory:', 5);
    const window = { from: 0, to: now };
    const first = store.importEntries('ical', 'calendar', window, [
      { uid: 'a', title: 'Lecture', subtitle: 'Room 1', startedAt: now - 3_600_000, endedAt: now - 1_800_000 },
      { uid: 'b', title: 'Gym', startedAt: now - 7_200_000, endedAt: now - 6_000_000 },
      { uid: 'old', title: 'Too old', startedAt: 1_000, endedAt: 2_000 },
    ]);
    expect(first).toEqual({ added: 2, updated: 0, removed: 0 });
    const id = store.query({ sourceId: 'ical' }).find((item) => item.key === 'a')!.id;
    expect(store.importEntries('ical', 'calendar', window, [
      { uid: 'a', title: 'Lecture (moved)', startedAt: now - 3_000_000, endedAt: now - 1_000_000 },
    ])).toEqual({ added: 0, updated: 1, removed: 1 });
    expect(store.query({ sourceId: 'ical' })).toEqual([expect.objectContaining({ id, title: 'Lecture (moved)', kind: 'event' })]);
    expect(store.importEntries('ical', 'calendar', window, [
      { uid: 'a', title: 'Lecture (moved)', startedAt: now - 3_000_000, endedAt: now - 1_000_000 },
    ])).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(store.today('UTC', now)).toMatchObject({ watching: 0, listening: 0, playing: 0 });
    expect(store.latest('ical', 5).map((item) => item.key)).toEqual(['a']);
    expect(store.deleteSource('ical')).toBe(1);
    expect(store.hasAny()).toBe(false);
  });

  it('returns intervals overlapping a query window rather than only those starting inside it', () => {
    let now = 100;
    const store = history(() => now);
    store.recordSource('plex', activity());
    now = 300;
    store.recordSource('plex', null);
    now = 400;
    store.recordSource('plex', activity());
    now = 600;
    expect(store.query({ from: 200, to: 500 })).toHaveLength(2);
    expect(store.query({ from: 300, to: 400 })).toHaveLength(0);
    expect(store.query({ from: 450, to: 500 })[0]?.startedAt).toBe(400);
  });

  it('writes heartbeats on its timer, prunes daily, and stops the timer on close', async () => {
    vi.useFakeTimers({ now: 0 });
    const database = file();
    const store = new HistoryStore(database, { retentionDays: 1, heartbeatIntervalMs: 15_000 });
    stores.push(store);
    store.recordSource('plex', activity());
    await vi.advanceTimersByTimeAsync(15_000);
    const reader = new DatabaseSync(database);
    expect(reader.prepare("SELECT value FROM history_meta WHERE key = 'last_seen'").get()?.value).toBe('15000');
    reader.close();
    store.recordSource('plex', null);
    vi.setSystemTime(2 * 86_400_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.query()).toHaveLength(0);
    store.close();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('daily totals', () => {
  it('counts duplicate movie observations once and excludes paused time while preserving displayed time', () => {
    const minute = 60_000;
    let now = Date.parse('2026-10-10T12:00:00Z');
    const store = history(() => now);
    store.recordSource('plex', activity());
    store.recordSource('trakt', activity());
    now += 10 * minute;
    store.recordSource('trakt', null);
    store.recordSource('plex', activity({ paused: true }));
    store.recordShown('discord', shown({ paused: true }));
    now += 5 * minute;
    store.recordShown('calendar', shown({ paused: true }));
    now += 5 * minute;
    store.recordSource('plex', null);
    store.recordShown('discord', null);
    store.recordShown('calendar', null);

    expect(store.today('UTC')).toMatchObject({
      watching: 10 * minute, listening: 0, playing: 0, displayed: 10 * minute,
    });
    expect(store.query({ scope: 'source' })).toHaveLength(3);
  });

  it.each(['watching', 'listening', 'playing'] as const)('unions active %s intervals after clipping them to the local day and query time', (kind) => {
    const minute = 60_000;
    let now = Date.parse('2026-10-10T04:50:00Z');
    const store = history(() => now);
    store.recordSource('first', activity({ kind }));
    now += 5 * minute;
    store.recordSource('second', activity({ kind, key: 'another-item' }));
    now = Date.parse('2026-10-10T05:05:00Z');
    store.recordSource('first', activity({ kind, paused: true }));
    now += 5 * minute;
    store.recordSource('second', activity({ kind, key: 'another-item', paused: true }));
    now = Date.parse('2026-10-10T05:25:00Z');
    store.recordSource('first', activity({ kind }));
    now += 15 * minute;

    expect(store.today('America/Chicago')).toMatchObject({
      watching: 0, listening: 0, playing: 0, displayed: 0, [kind]: 25 * minute,
    });
    expect(store.today('America/Chicago', Date.parse('2026-10-10T05:30:00Z'))[kind]).toBe(15 * minute);
  });

  it('counts simultaneous activity of different kinds independently', () => {
    let now = Date.parse('2026-10-10T12:00:00Z');
    const store = history(() => now);
    store.recordSource('plex', activity());
    store.recordSource('music', activity({ kind: 'listening' }));
    store.recordSource('switch', activity({ kind: 'playing' }));
    now += 10 * 60_000;

    expect(store.today('UTC')).toMatchObject({ watching: 600_000, listening: 600_000, playing: 600_000 });
  });

  it('clips source intervals to the local day and counts overlapping output intervals once', () => {
    let now = Date.parse('2026-10-10T04:00:00Z'); // 11 PM in Chicago on October 9.
    const store = history(() => now);
    store.recordSource('plex', activity());
    store.recordShown('discord', shown());
    now = Date.parse('2026-10-10T06:00:00Z');
    store.recordShown('calendar', shown());
    now = Date.parse('2026-10-10T07:00:00Z');
    store.recordSource('plex', null);
    store.recordSource('music', activity({ kind: 'listening' }));
    store.recordShown('discord', null);
    now = Date.parse('2026-10-10T08:00:00Z');
    store.recordShown('calendar', null);
    store.recordSource('music', null);
    const stats = store.today('America/Chicago');
    expect(stats).toEqual({
      startAt: Date.parse('2026-10-10T05:00:00Z'), endAt: Date.parse('2026-10-11T05:00:00Z'),
      watching: 2 * 3_600_000, listening: 3_600_000, playing: 0, displayed: 3 * 3_600_000,
    });
  });

  it('uses actual DST boundaries for short and long days', () => {
    const spring = zonedDayBounds(Date.parse('2026-03-08T12:00:00Z'), 'America/Chicago');
    expect(spring).toEqual({ startAt: Date.parse('2026-03-08T06:00:00Z'), endAt: Date.parse('2026-03-09T05:00:00Z') });
    expect(spring.endAt - spring.startAt).toBe(23 * 3_600_000);
    const fall = zonedDayBounds(Date.parse('2026-11-01T12:00:00Z'), 'America/Chicago');
    expect(fall).toEqual({ startAt: Date.parse('2026-11-01T05:00:00Z'), endAt: Date.parse('2026-11-02T06:00:00Z') });
    expect(fall.endAt - fall.startAt).toBe(25 * 3_600_000);
    const nepal = zonedDayBounds(Date.parse('2026-10-10T12:00:00Z'), 'Asia/Kathmandu');
    expect(nepal.startAt).toBe(Date.parse('2026-10-09T18:15:00Z'));
    expect(() => zonedDayBounds(Date.now(), 'Mars/Olympus')).toThrow();
  });

  it('merges contained and touching intervals', () => {
    expect(unionDuration([[10, 30], [20, 40], [25, 28], [40, 50], [70, 80]])).toBe(50);
    expect(unionDuration([])).toBe(0);
    expect(unionDuration([[-10, 0], [-5, 5]])).toBe(15);
  });
});

function reader(store: HistoryStore, excluded: string[] = []): HistoryReader {
  return {
    query: (options = {}) => store.query({ ...options, excludeOrigins: [...(options.excludeOrigins ?? []), ...excluded] }),
    timeZone: () => 'UTC',
    label: (id) => ({ plex: 'Plex' } as Record<string, string>)[id] ?? id,
    legacyFeedToken: () => undefined,
  };
}

const FEED = { content: 'activity', kinds: ['watching', 'listening', 'playing'], combine: true, includePaused: false, pastDays: 30, calendarName: 'Understudy' } as const;
const feed = (overrides: Partial<{ -readonly [K in keyof typeof FEED]: unknown }> = {}) => ({ ...FEED, ...overrides }) as Parameters<typeof historyCalendar>[1];

describe('calendar feed', () => {
  it('retains calendar UIDs as open events finish, escapes text, and folds UTF-8 lines', () => {
    let now = Date.parse('2026-10-10T12:00:00Z');
    const store = history(() => now);
    store.recordSource('plex', activity({ title: 'Movie, part; one\\two\nnext', subtitle: 'é'.repeat(90) }));
    now += 60_000;
    const open = historyCalendar(reader(store), feed(), now);
    const uid = open.match(/UID:([^\r]+)/)?.[1];
    expect(uid).toMatch(/@understudy$/);
    expect(open).toContain('SUMMARY:Movie\\, part\\; one\\\\two\\nnext');
    expect(open).toContain('DTSTART:20261010T120000Z');
    store.recordSource('plex', null);
    const closed = historyCalendar(reader(store), feed(), now);
    expect(closed).toContain(`UID:${uid}`);
    expect(closed).toContain('DTEND:20261010T120100Z');
    expect(closed).toContain('LAST-MODIFIED:20261010T120100Z');
    for (const line of closed.trimEnd().split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const long = 'DESCRIPTION:' + '🎮'.repeat(60);
    expect(foldCalendarLine(long).replace(/\r\n /g, '')).toBe(long);
  });

  it('combines back-to-back tracks into one event, leaves out paused time, and never includes calendar imports', () => {
    let now = Date.parse('2026-10-10T12:00:00Z');
    const store = history(() => now);
    for (let index = 1; index <= 3; index++) {
      store.recordSource('music', activity({ key: `t${index}`, kind: 'listening', title: `Track ${index}`, subtitle: 'Artist' }));
      now += 180_000;
    }
    store.recordSource('music', null);
    store.recordSource('plex', activity({ paused: true }));
    now += 60_000;
    store.recordSource('plex', null);
    store.importEntries('ical', 'calendar', { from: 0, to: now }, [{ uid: 'x', title: 'Imported lecture', startedAt: now - 60_000, endedAt: now }]);
    store.observe('discord-status', 'discord', [{ key: 'g', kind: 'playing', title: 'Hades II' }]);
    now += 60_000;
    // The registry applies the no-echo rule; a calendar feed's reader leaves out `calendar` origins.
    const text = historyCalendar(reader(store, ['calendar']), feed(), now);
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(text).toContain('SUMMARY:Artist');
    expect(text).toContain('DESCRIPTION:3 tracks\\nListening · music');
    expect(text).toContain('SUMMARY:Hades II');
    expect(text).not.toContain('Imported lecture');
    expect(text).not.toContain('Paused');
    const separate = historyCalendar(reader(store, ['calendar']), feed({ combine: false, includePaused: true, kinds: ['listening', 'watching'] }), now);
    expect(separate.match(/BEGIN:VEVENT/g)).toHaveLength(4);
    expect(separate).toContain('Paused');
  });
});

describe('session grouping', () => {
  it('merges same-source items within the gap and keeps events and other sources apart', () => {
    const base = { paused: false, kind: 'watching' as const, key: 'k' };
    const groups = groupSegments([
      { ...base, id: '1', sourceId: 'plex', title: 'Show', subtitle: 'S01E01', startedAt: 0, endedAt: 100 },
      { ...base, id: '2', sourceId: 'plex', title: 'Show', subtitle: 'S01E02', startedAt: 200, endedAt: 300 },
      { ...base, id: '3', sourceId: 'jellyfin', title: 'Movie', startedAt: 250, endedAt: 400 },
      { ...base, id: '4', sourceId: 'plex', title: 'Show', subtitle: 'S01E03', startedAt: 10 * 60_000, endedAt: 11 * 60_000 },
      { ...base, id: '5', sourceId: 'ical', kind: 'event', title: 'A', startedAt: 0, endedAt: 50 },
      { ...base, id: '6', sourceId: 'ical', kind: 'event', title: 'B', startedAt: 50, endedAt: 60 },
    ]);
    expect(groups.map((group) => [group.id, group.title, group.subtitle, group.items.length])).toEqual([
      ['1', 'Show', '2 episodes', 2],
      ['5', 'A', undefined, 1],
      ['6', 'B', undefined, 1],
      ['3', 'Movie', undefined, 1],
      ['4', 'Show', 'S01E03', 1],
    ]);
  });
});
