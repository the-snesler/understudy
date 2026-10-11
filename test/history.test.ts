import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NowPlaying, SourceActivity } from '../src/core/activity.js';
import { HistoryStore, unionDuration, zonedDayBounds } from '../src/core/history.js';
import { foldCalendarLine, historyCalendar, historyFeedUrls, registerHistoryRoutes } from '../src/web/history.js';

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

  it('creates private SQLite files and persists the feed token', () => {
    const database = file();
    const first = history(() => 100, database);
    const token = first.token();
    first.close();
    const second = history(() => 200, database);
    expect(fs.statSync(database).mode & 0o777).toBe(0o600);
    expect(second.token()).toBe(token);
    expect(second.validToken(token)).toBe(true);
    const next = second.regenerateToken();
    expect(next).not.toBe(token);
    expect(second.validToken(token)).toBe(false);
    expect(second.validToken(undefined)).toBe(false);
    expect(second.validToken(next)).toBe(true);
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

describe('public history feeds', () => {
  it('requires the URL token, rotates links, and bypasses subsequent UI password middleware', async () => {
    let now = 1_000;
    const store = history(() => now);
    store.recordSource('plex', activity());
    store.recordShown('discord', shown());
    now = 10_000;
    const app = new Hono();
    registerHistoryRoutes(app, store, { timeZone: () => 'America/Chicago', now: () => now });
    app.use('*', async (c) => c.text('UI password needed', 401));
    expect((await app.request('/api/history.json')).status).toBe(401);
    expect((await app.request('/feed/history.ics?token=wrong')).status).toBe(401);
    const token = store.token();
    const json = await app.request(`/api/history.json?token=${token}`);
    expect(json.status).toBe(200);
    expect(json.headers.get('cache-control')).toBe('private, no-store');
    expect(await json.json()).toMatchObject({ generatedAt: 10_000, timeZone: 'America/Chicago', segments: [{ sourceId: 'plex' }], outputSegments: [{ outputId: 'discord' }] });
    const calendar = await app.request(`/feed/history.ics?token=${token}`);
    expect(calendar.status).toBe(200);
    expect(calendar.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(await calendar.text()).toContain('BEGIN:VEVENT');
    expect((await app.request(`/api/history.json?token=${token}&from=bad`)).status).toBe(400);
    expect((await app.request(`/api/history.json?token=${token}&from=20&to=10`)).status).toBe(400);
    store.regenerateToken();
    expect((await app.request(`/api/history.json?token=${token}`)).status).toBe(401);
    expect(historyFeedUrls('https://example.test/', 'x+y')).toEqual({ calendar: 'https://example.test/feed/history.ics?token=x%2By', json: 'https://example.test/api/history.json?token=x%2By' });
  });

  it('retains calendar UIDs as open events finish, escapes text, and folds UTF-8 lines', () => {
    let now = Date.parse('2026-10-10T12:00:00Z');
    const store = history(() => now);
    store.recordSource('plex', activity({ title: 'Movie, part; one\\two\nnext', subtitle: 'é'.repeat(90) }));
    now += 60_000;
    const open = historyCalendar(store.query(), now);
    const uid = open.match(/UID:([^\r]+)/)?.[1];
    expect(uid).toMatch(/@understudy$/);
    expect(open).toContain('SUMMARY:Movie\\, part\\; one\\\\two\\nnext');
    expect(open).toContain('DTSTART:20261010T120000Z');
    store.recordSource('plex', null);
    const closed = historyCalendar(store.query(), now);
    expect(closed).toContain(`UID:${uid}`);
    expect(closed).toContain('DTEND:20261010T120100Z');
    expect(closed).toContain('LAST-MODIFIED:20261010T120100Z');
    for (const line of closed.trimEnd().split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const long = 'DESCRIPTION:' + '🎮'.repeat(60);
    expect(foldCalendarLine(long).replace(/\r\n /g, '')).toBe(long);
  });
});
