import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ActivityKind, NowPlaying, SourceActivity } from './activity.js';

const DAY_MS = 86_400_000;
export const DEFAULT_RETENTION_DAYS = 90;
const SCHEMA_VERSION = 1;

/** Activity kinds, plus `event` for entries imported from a calendar. */
export type HistoryKind = ActivityKind | 'event';
export const ACTIVITY_KINDS: readonly ActivityKind[] = ['watching', 'listening', 'playing'];

/** Observed time, rather than the media's playback timestamps. */
export interface HistorySegment {
  id: string;
  sourceId: string;
  /** Present only for confirmed output activity. */
  outputId?: string;
  key: string;
  kind: HistoryKind;
  title: string;
  subtitle?: string;
  startedAt: number;
  endedAt: number | null;
  paused: boolean;
  /**
   * The outside service a history source copied this from (e.g. `calendar`, `discord`). Absent for
   * live sources. Outputs for the same service never receive it: see the no-echo rule in plugin.ts.
   */
  origin?: string;
}

/** Something a history source currently sees, such as one of your Discord activities. */
export interface HistoryObservation {
  key: string;
  kind: ActivityKind;
  title: string;
  subtitle?: string;
}

/** A finished (or scheduled) entry copied from elsewhere, such as one calendar event occurrence. */
export interface ImportedEntry {
  /** Stable within the source, e.g. the event UID plus its occurrence. Updates keep the row's id. */
  uid: string;
  title: string;
  subtitle?: string;
  startedAt: number;
  endedAt: number;
}

export interface ImportResult {
  added: number;
  updated: number;
  removed: number;
}

export interface HistoryQuery {
  scope?: 'source' | 'output' | 'all';
  /** Return intervals overlapping [from, to); returned timestamps are not clipped. */
  from?: number;
  to?: number;
  sourceId?: string;
  outputId?: string;
  /** Leave out entries copied from these services. */
  excludeOrigins?: string[];
}

export interface DailyStats {
  startAt: number;
  endAt: number;
  watching: number;
  listening: number;
  playing: number;
  displayed: number;
}

export interface HistoryOptions {
  now?: () => number;
  retentionDays?: number;
  /** Zero disables the automatic heartbeat, for deterministic callers/tests. */
  heartbeatIntervalMs?: number;
}

interface SegmentRow {
  id: string;
  source_id: string;
  output_id: string | null;
  activity_key: string;
  kind: ActivityKind;
  title: string;
  subtitle: string | null;
  started_at: number;
  ended_at: number | null;
  paused: number;
  origin: string | null;
  external_id: string | null;
}

function segment(row: SegmentRow): HistorySegment {
  return {
    id: row.id,
    sourceId: row.source_id,
    ...(row.output_id === null ? {} : { outputId: row.output_id }),
    key: row.activity_key,
    kind: row.kind,
    title: row.title,
    ...(row.subtitle === null ? {} : { subtitle: row.subtitle }),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    paused: row.paused === 1,
    ...(row.origin === null ? {} : { origin: row.origin }),
  };
}

const TABLE = `(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  output_id TEXT,
  activity_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('playing', 'watching', 'listening', 'event')),
  title TEXT NOT NULL,
  subtitle TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  origin TEXT,
  external_id TEXT,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
) STRICT`;

/**
 * Every source is recorded independently; displayed activity is recorded only after an output
 * confirms it. An interrupted process leaves intervals open, which the next process closes at the
 * saved heartbeat before accepting new activity. Keep one writer per data directory.
 */
export class HistoryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private retentionDays: number;
  private readonly timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private nextPruneAt = 0;

  constructor(readonly file: string, options: HistoryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retentionDays = checkedRetention(options.retentionDays ?? DEFAULT_RETENTION_DAYS);
    const interval = options.heartbeatIntervalMs ?? 15_000;
    if (!Number.isFinite(interval) || interval < 0) throw new Error('Heartbeat interval must be nonnegative.');
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // Create with private permissions before SQLite ever writes sensitive activity to it.
      fs.closeSync(fs.openSync(file, 'a', 0o600));
      fs.chmodSync(file, 0o600);
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS history_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
    this.migrate();
    const at = checkedTime(this.now());
    const saved = Number(this.meta('last_seen'));
    const lastSeen = Number.isFinite(saved) ? Math.min(saved, at) : at;
    this.db.prepare('UPDATE history_segments SET ended_at = MAX(started_at, ?) WHERE ended_at IS NULL').run(lastSeen);
    this.heartbeat(at);
    if (interval > 0) {
      this.timer = setInterval(() => this.heartbeat(), interval);
      this.timer.unref();
    }
  }

  /** Version 0 allowed only activity kinds and had no origin; SQLite can't alter a CHECK in place. */
  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > SCHEMA_VERSION) throw new Error('history.sqlite was written by a newer version of Understudy.');
    const exists = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'history_segments'").get();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!exists) this.db.exec(`CREATE TABLE history_segments ${TABLE}`);
      else if (version < 1) {
        this.db.exec(`
          CREATE TABLE history_segments_v1 ${TABLE};
          INSERT INTO history_segments_v1
            (id, source_id, output_id, activity_key, kind, title, subtitle, started_at, ended_at, paused)
            SELECT id, source_id, output_id, activity_key, kind, title, subtitle, started_at, ended_at, paused
            FROM history_segments;
          DROP TABLE history_segments;
          ALTER TABLE history_segments_v1 RENAME TO history_segments;
        `);
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS history_time ON history_segments(started_at, ended_at);
        CREATE INDEX IF NOT EXISTS history_source ON history_segments(source_id, started_at);
        CREATE INDEX IF NOT EXISTS history_output ON history_segments(output_id, started_at);
        CREATE UNIQUE INDEX IF NOT EXISTS history_open_source
          ON history_segments(source_id) WHERE ended_at IS NULL AND output_id IS NULL AND origin IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS history_open_output
          ON history_segments(output_id) WHERE ended_at IS NULL AND output_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS history_open_observed
          ON history_segments(source_id, activity_key) WHERE ended_at IS NULL AND origin IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS history_external
          ON history_segments(source_id, external_id) WHERE external_id IS NOT NULL;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordSource(sourceId: string, activity: NowPlaying | null, at = this.now()): void {
    this.record(sourceId, null, activity, at);
  }

  recordShown(outputId: string, shown: SourceActivity | null, at = this.now()): void {
    this.record(shown?.sourceId ?? '', outputId, shown?.activity ?? null, at);
  }

  private record(sourceId: string, outputId: string | null, activity: NowPlaying | null, time: number): void {
    this.assertOpen();
    const at = checkedTime(time);
    const row = (outputId === null
      ? this.db.prepare('SELECT * FROM history_segments WHERE source_id = ? AND output_id IS NULL AND origin IS NULL AND ended_at IS NULL').get(sourceId)
      : this.db.prepare('SELECT * FROM history_segments WHERE output_id = ? AND ended_at IS NULL').get(outputId)) as SegmentRow | undefined;
    // Artwork refreshes, progress reports and seeks never create more history entries.
    if (row && activity && row.source_id === sourceId && row.activity_key === activity.key &&
      row.kind === activity.kind && row.title === activity.title &&
      row.subtitle === (activity.subtitle ?? null) && row.paused === Number(!!activity.paused)) return;
    if (!row && !activity) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (row) this.db.prepare('UPDATE history_segments SET ended_at = MAX(started_at, ?) WHERE id = ?').run(at, row.id);
      if (activity) {
        this.db.prepare(`INSERT INTO history_segments
          (id, source_id, output_id, activity_key, kind, title, subtitle, started_at, paused)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          randomUUID(), sourceId, outputId, activity.key, activity.kind, activity.title,
          activity.subtitle ?? null, at, Number(!!activity.paused),
        );
      }
      this.setMeta('last_seen', String(at));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Replace what a history source currently sees: entries that disappeared end now and new ones
   * start now. Unlike live sources, several entries can be open at once (a game and a song).
   */
  observe(sourceId: string, origin: string, items: HistoryObservation[], time = this.now()): void {
    this.assertOpen();
    const at = checkedTime(time);
    const wanted = new Map(items.map((item) => [item.key, item]));
    const open = this.db.prepare(`SELECT * FROM history_segments
      WHERE source_id = ? AND origin IS NOT NULL AND external_id IS NULL AND ended_at IS NULL`).all(sourceId) as unknown as SegmentRow[];
    const unchanged = (row: SegmentRow, item: HistoryObservation | undefined) => !!item && row.kind === item.kind &&
      row.title === item.title && row.subtitle === (item.subtitle ?? null);
    const closing = open.filter((row) => !unchanged(row, wanted.get(row.activity_key)));
    const kept = new Set(open.filter((row) => !closing.includes(row)).map((row) => row.activity_key));
    const opening = [...wanted.values()].filter((item) => !kept.has(item.key));
    if (!closing.length && !opening.length) return;
    this.transaction(() => {
      for (const row of closing) this.db.prepare('UPDATE history_segments SET ended_at = MAX(started_at, ?) WHERE id = ?').run(at, row.id);
      for (const item of opening) {
        this.db.prepare(`INSERT INTO history_segments
          (id, source_id, output_id, activity_key, kind, title, subtitle, started_at, paused, origin)
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, ?)`).run(
          randomUUID(), sourceId, item.key, item.kind, item.title, item.subtitle ?? null, at, origin,
        );
      }
      this.setMeta('last_seen', String(at));
    });
  }

  /**
   * Make a source's imported entries starting within [from, to) match `entries`: new ones are
   * added, changed ones updated in place (keeping their id), and ones no longer listed removed.
   * Entries older than the retention period are skipped, so the next prune doesn't fight the import.
   */
  importEntries(sourceId: string, origin: string, window: { from: number; to: number }, entries: ImportedEntry[]): ImportResult {
    this.assertOpen();
    const cutoff = checkedTime(this.now()) - this.retentionDays * DAY_MS;
    const from = Math.max(checkedTime(window.from), cutoff);
    const to = checkedTime(window.to);
    const result: ImportResult = { added: 0, updated: 0, removed: 0 };
    const existing = new Map((this.db.prepare(`SELECT * FROM history_segments
      WHERE source_id = ? AND external_id IS NOT NULL AND started_at >= ? AND started_at < ?`).all(sourceId, from, to) as unknown as SegmentRow[])
      .map((row) => [row.external_id!, row]));
    const seen = new Set<string>();
    this.transaction(() => {
      for (const entry of entries) {
        if (seen.has(entry.uid) || entry.endedAt <= cutoff || entry.startedAt < from || entry.startedAt >= to) continue;
        seen.add(entry.uid);
        const startedAt = checkedTime(entry.startedAt);
        const endedAt = Math.max(startedAt, checkedTime(entry.endedAt));
        const row = existing.get(entry.uid) ?? this.db.prepare('SELECT * FROM history_segments WHERE source_id = ? AND external_id = ?')
          .get(sourceId, entry.uid) as SegmentRow | undefined;
        if (!row) {
          this.db.prepare(`INSERT INTO history_segments
            (id, source_id, output_id, activity_key, kind, title, subtitle, started_at, ended_at, paused, origin, external_id)
            VALUES (?, ?, NULL, ?, 'event', ?, ?, ?, ?, 0, ?, ?)`).run(
            randomUUID(), sourceId, entry.uid, entry.title, entry.subtitle ?? null, startedAt, endedAt, origin, entry.uid,
          );
          result.added++;
        } else if (row.title !== entry.title || row.subtitle !== (entry.subtitle ?? null) || row.started_at !== startedAt || row.ended_at !== endedAt) {
          this.db.prepare('UPDATE history_segments SET title = ?, subtitle = ?, started_at = ?, ended_at = ?, origin = ? WHERE id = ?')
            .run(entry.title, entry.subtitle ?? null, startedAt, endedAt, origin, row.id);
          result.updated++;
        }
      }
      for (const [uid, row] of existing) {
        if (seen.has(uid)) continue;
        this.db.prepare('DELETE FROM history_segments WHERE id = ?').run(row.id);
        result.removed++;
      }
    });
    return result;
  }

  /** Whether anything has been recorded yet. */
  hasAny(): boolean {
    this.assertOpen();
    return !!this.db.prepare('SELECT 1 FROM history_segments LIMIT 1').get();
  }

  /** A source's most recent segments, newest first. */
  latest(sourceId: string, limit: number): HistorySegment[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT * FROM history_segments WHERE source_id = ? AND output_id IS NULL
      ORDER BY started_at DESC, id DESC LIMIT ?`).all(sourceId, Math.max(0, Math.floor(limit))) as unknown as SegmentRow[];
    return rows.map(segment);
  }

  /** Remove everything recorded under a source id, e.g. when a history source is removed. */
  deleteSource(sourceId: string): number {
    this.assertOpen();
    return Number(this.db.prepare('DELETE FROM history_segments WHERE source_id = ? AND output_id IS NULL').run(sourceId).changes);
  }

  heartbeat(at = this.now()): void {
    this.assertOpen();
    this.setMeta('last_seen', String(checkedTime(at)));
    if (at >= this.nextPruneAt) {
      this.prune(at);
      this.nextPruneAt = at + DAY_MS;
    }
  }

  setRetention(days: number): void {
    this.retentionDays = checkedRetention(days);
    this.prune();
  }

  prune(at = this.now()): number {
    this.assertOpen();
    const cutoff = checkedTime(at) - this.retentionDays * DAY_MS;
    return Number(this.db.prepare('DELETE FROM history_segments WHERE ended_at IS NOT NULL AND ended_at <= ?').run(cutoff).changes);
  }

  query(options: HistoryQuery = {}): HistorySegment[] {
    this.assertOpen();
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    if (options.scope === 'source') clauses.push('output_id IS NULL');
    if (options.scope === 'output') clauses.push('output_id IS NOT NULL');
    if (options.from !== undefined) {
      clauses.push('COALESCE(ended_at, ?) > ?');
      values.push(this.now(), checkedTime(options.from));
    }
    if (options.to !== undefined) {
      clauses.push('started_at < ?');
      values.push(checkedTime(options.to));
    }
    if (options.sourceId !== undefined) {
      clauses.push('source_id = ?');
      values.push(options.sourceId);
    }
    if (options.outputId !== undefined) {
      clauses.push('output_id = ?');
      values.push(options.outputId);
    }
    if (options.excludeOrigins?.length) {
      clauses.push(`(origin IS NULL OR origin NOT IN (${options.excludeOrigins.map(() => '?').join(', ')}))`);
      values.push(...options.excludeOrigins);
    }
    const rows = this.db.prepare(`SELECT * FROM history_segments ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY started_at ASC, id ASC`).all(...values) as unknown as SegmentRow[];
    return rows.map(segment);
  }

  today(timeZone: string, at = this.now()): DailyStats {
    const bounds = zonedDayBounds(at, timeZone);
    const end = Math.min(at, bounds.endAt);
    return { ...bounds, ...activityTotals(this.query({ from: bounds.startAt, to: end }), bounds.startAt, end, at) };
  }

  /**
   * The single feed token from before feeds became outputs. The first Calendar feed and JSON feed
   * outputs adopt it, so links people already subscribed to keep working.
   */
  legacyFeedToken(): string | undefined {
    this.assertOpen();
    return this.meta('feed_token');
  }

  /** Graceful shutdown closes intervals now; an ungraceful stop is recovered by the heartbeat. */
  close(at = this.now()): void {
    if (this.closed) return;
    clearInterval(this.timer);
    const time = checkedTime(at);
    this.db.prepare('UPDATE history_segments SET ended_at = MAX(started_at, ?) WHERE ended_at IS NULL').run(time);
    this.setMeta('last_seen', String(time));
    this.db.close();
    this.closed = true;
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private meta(key: string): string | undefined {
    return this.db.prepare('SELECT value FROM history_meta WHERE key = ?').get(key)?.value as string | undefined;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO history_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('History store is closed.');
  }
}

function checkedTime(at: number): number {
  if (!Number.isSafeInteger(at)) throw new Error('History timestamps must be finite integer milliseconds.');
  return at;
}

function checkedRetention(days: number): number {
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('History retention must be a positive whole number of days.');
  return days;
}

/** Midnight boundaries in an IANA zone, including 23/25-hour days and fractional UTC offsets. */
export function zonedDayBounds(at: number, timeZone: string): { startAt: number; endAt: number } {
  checkedTime(at);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, calendar: 'iso8601', year: 'numeric', month: 'numeric', day: 'numeric',
  });
  const dayAt = (time: number) => {
    const parts = formatter.formatToParts(time);
    const number = (type: string) => Number(parts.find((part) => part.type === type)!.value);
    return Date.UTC(number('year'), number('month') - 1, number('day'));
  };
  const day = dayAt(at);
  const first = (low: number, high: number, target: number) => {
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (dayAt(middle) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return {
    startAt: first(at - 2 * DAY_MS, at, day),
    endAt: first(at, at + 2 * DAY_MS, day + DAY_MS),
  };
}

export type ActivityTotals = Omit<DailyStats, 'startAt' | 'endAt'>;

/**
 * Active time per kind within [from, to), counting overlapping observations of a kind once and
 * leaving out paused time and calendar events. Displayed time is the union of output intervals.
 */
export function activityTotals(items: HistorySegment[], from: number, to: number, at: number): ActivityTotals {
  const active: Record<ActivityKind, [number, number][]> = { watching: [], listening: [], playing: [] };
  const displayed: [number, number][] = [];
  for (const item of items) {
    const start = Math.max(item.startedAt, from);
    const finish = Math.min(item.endedAt ?? at, to, at);
    if (finish <= start) continue;
    if (item.outputId !== undefined) displayed.push([start, finish]);
    else if (!item.paused && item.kind !== 'event') active[item.kind].push([start, finish]);
  }
  return {
    watching: unionDuration(active.watching),
    listening: unionDuration(active.listening),
    playing: unionDuration(active.playing),
    displayed: unionDuration(displayed),
  };
}

/** Elapsed time covered by intervals, counting overlaps only once. */
export function unionDuration(intervals: [number, number][]): number {
  const sorted = intervals.filter(([start, end]) => end > start).sort(([a], [b]) => a - b);
  if (!sorted.length) return 0;
  let total = 0;
  let [start, end] = sorted[0]!;
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart > end) {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    } else end = Math.max(end, nextEnd);
  }
  return total + end - start;
}
