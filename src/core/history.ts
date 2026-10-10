import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ActivityKind, NowPlaying, SourceActivity } from './activity.js';

const DAY_MS = 86_400_000;
export const DEFAULT_RETENTION_DAYS = 90;

/** Observed time, rather than the media's playback timestamps. */
export interface HistorySegment {
  id: string;
  sourceId: string;
  /** Present only for confirmed output activity. */
  outputId?: string;
  key: string;
  kind: ActivityKind;
  title: string;
  subtitle?: string;
  startedAt: number;
  endedAt: number | null;
  paused: boolean;
}

export interface HistoryQuery {
  scope?: 'source' | 'output' | 'all';
  /** Return intervals overlapping [from, to); returned timestamps are not clipped. */
  from?: number;
  to?: number;
  sourceId?: string;
  outputId?: string;
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
  };
}

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
      CREATE TABLE IF NOT EXISTS history_segments (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        output_id TEXT,
        activity_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('playing', 'watching', 'listening')),
        title TEXT NOT NULL,
        subtitle TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
        CHECK (ended_at IS NULL OR ended_at >= started_at)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS history_time ON history_segments(started_at, ended_at);
      CREATE INDEX IF NOT EXISTS history_source ON history_segments(source_id, started_at);
      CREATE INDEX IF NOT EXISTS history_output ON history_segments(output_id, started_at);
      CREATE UNIQUE INDEX IF NOT EXISTS history_open_source
        ON history_segments(source_id) WHERE ended_at IS NULL AND output_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS history_open_output
        ON history_segments(output_id) WHERE ended_at IS NULL AND output_id IS NOT NULL;
    `);
    const at = checkedTime(this.now());
    const saved = Number(this.meta('last_seen'));
    const lastSeen = Number.isFinite(saved) ? Math.min(saved, at) : at;
    this.db.prepare('UPDATE history_segments SET ended_at = MAX(started_at, ?) WHERE ended_at IS NULL').run(lastSeen);
    if (!this.meta('feed_token')) this.setMeta('feed_token', randomBytes(32).toString('base64url'));
    this.heartbeat(at);
    if (interval > 0) {
      this.timer = setInterval(() => this.heartbeat(), interval);
      this.timer.unref();
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
      ? this.db.prepare('SELECT * FROM history_segments WHERE source_id = ? AND output_id IS NULL AND ended_at IS NULL').get(sourceId)
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
    const rows = this.db.prepare(`SELECT * FROM history_segments ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY started_at ASC, id ASC`).all(...values) as unknown as SegmentRow[];
    return rows.map(segment);
  }

  today(timeZone: string, at = this.now()): DailyStats {
    const bounds = zonedDayBounds(at, timeZone);
    const result: DailyStats = { ...bounds, watching: 0, listening: 0, playing: 0, displayed: 0 };
    const end = Math.min(at, bounds.endAt);
    const displayed: [number, number][] = [];
    for (const item of this.query({ from: bounds.startAt, to: end })) {
      const start = Math.max(item.startedAt, bounds.startAt);
      const finish = Math.min(item.endedAt ?? at, end);
      if (finish <= start) continue;
      if (item.outputId !== undefined) displayed.push([start, finish]);
      else result[item.kind] += finish - start;
    }
    result.displayed = unionDuration(displayed);
    return result;
  }

  token(): string {
    this.assertOpen();
    return this.meta('feed_token')!;
  }

  validToken(candidate: string | undefined): boolean {
    if (!candidate) return false;
    const hash = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(hash(candidate), hash(this.token()));
  }

  regenerateToken(): string {
    this.assertOpen();
    const token = randomBytes(32).toString('base64url');
    this.setMeta('feed_token', token);
    return token;
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

/** Overlapping output sessions count once, even when several outputs display the activity. */
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
