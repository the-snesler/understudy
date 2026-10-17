import { activityTotals, zonedDayBounds, type ActivityTotals, type HistorySegment, type HistoryStore } from '../core/history.js';
import { groupSegments, type HistoryGroup } from '../core/timeline.js';

/** `YYYY-MM-DD` for an instant in a time zone. */
export function localDate(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function parseDate(value: string | undefined): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? { year, month, day } : undefined;
}

/** Shift a `YYYY-MM-DD` date by whole days, in calendar terms (no time zone involved). */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date)!;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Local midnight to midnight for a calendar date (23 or 25 hours on clock changes). */
export function dayBounds(date: string, timeZone: string): { startAt: number; endAt: number } {
  const { year, month, day } = parseDate(date)!;
  // Noon UTC is within a day of local noon everywhere; step until the local date matches.
  let probe = Date.UTC(year, month - 1, day, 12);
  for (let i = 0; i < 3; i++) {
    const local = localDate(probe, timeZone);
    if (local === date) break;
    probe += local < date ? 12 * 3_600_000 : -12 * 3_600_000;
  }
  return zonedDayBounds(probe, timeZone);
}

/** Monday of the week containing the date. */
export function weekStart(date: string): string {
  const { year, month, day } = parseDate(date)!;
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

/** A session placed in one day's column, clipped to that day. */
export interface DayBlock {
  group: HistoryGroup;
  /** Fractions of the day, 0–1. */
  top: number;
  height: number;
  lane: number;
  lanes: number;
  /** The session started before this day or runs past it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface CalendarDay {
  date: string;
  startAt: number;
  endAt: number;
  isToday: boolean;
  isFuture: boolean;
  activity: DayBlock[];
  /** Calendar events, drawn behind activity. */
  events: DayBlock[];
  /** When outputs showed something, as fractions of the day. */
  displayed: { top: number; height: number }[];
  totals: ActivityTotals;
  /** Sessions overlapping the day, for the agenda: activity and events together, by start. */
  groups: HistoryGroup[];
  /** Output segments overlapping the day, to mark agenda items that were shown. */
  shown: HistorySegment[];
}

export interface CalendarWeek {
  timeZone: string;
  selected: string;
  today: string;
  start: string;
  days: CalendarDay[];
  totals: ActivityTotals;
  /** Whether any history exists at all, to tell an empty week from an empty install. */
  hasHistory: boolean;
  now: number;
}

/** Sessions shorter than this still get a visible block. */
const MIN_BLOCK = 15 / 1440;

export function calendarWeek(history: HistoryStore | undefined, timeZone: string, selected: string | undefined, now = Date.now()): CalendarWeek {
  const today = localDate(now, timeZone);
  const date = parseDate(selected) ? selected! : today;
  const start = weekStart(date);
  const dates = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  const bounds = dates.map((day) => dayBounds(day, timeZone));
  const from = bounds[0]!.startAt;
  const to = bounds[6]!.endAt;
  const segments = history?.query({ from, to }) ?? [];
  const sources = segments.filter((item) => item.outputId === undefined && !item.paused);
  const outputs = segments.filter((item) => item.outputId !== undefined);
  const groups = groupSegments(sources);

  const days = dates.map((day, index): CalendarDay => {
    const { startAt, endAt } = bounds[index]!;
    const length = endAt - startAt;
    const overlapping = groups.filter((group) => group.startedAt < endAt && (group.endedAt ?? now) > startAt
      // A zero-length calendar event at midnight belongs to the day it starts.
      || (group.startedAt === group.endedAt && group.startedAt >= startAt && group.startedAt < endAt));
    const place = (items: HistoryGroup[]) => layout(items.map((group) => {
      const end = group.endedAt ?? Math.min(now, endAt);
      const top = Math.max(0, (group.startedAt - startAt) / length);
      const bottom = Math.min(1, (Math.min(end, endAt) - startAt) / length);
      return {
        group,
        top: Math.min(top, 1 - MIN_BLOCK),
        height: Math.max(bottom - top, MIN_BLOCK),
        lane: 0,
        lanes: 1,
        continuesBefore: group.startedAt < startAt,
        continuesAfter: end > endAt,
      };
    }));
    const shown = outputs.filter((item) => item.startedAt < endAt && (item.endedAt ?? now) > startAt);
    return {
      date: day,
      startAt,
      endAt,
      isToday: day === today,
      isFuture: startAt > now,
      activity: place(overlapping.filter((group) => group.kind !== 'event')),
      events: place(overlapping.filter((group) => group.kind === 'event')),
      displayed: mergeIntervals(shown.map((item) => [Math.max(item.startedAt, startAt), Math.min(item.endedAt ?? now, endAt)]))
        .map(([a, b]) => ({ top: (a - startAt) / length, height: (b - a) / length })),
      totals: activityTotals(segments, startAt, endAt, now),
      groups: overlapping,
      shown,
    };
  });

  return {
    timeZone,
    selected: date,
    today,
    start,
    days,
    totals: activityTotals(segments, from, to, now),
    hasHistory: segments.length > 0 || !!history?.hasAny(),
    now,
  };
}

/** Side-by-side lanes for overlapping blocks; each cluster of overlaps shares its lane count. */
function layout(blocks: DayBlock[]): DayBlock[] {
  blocks.sort((a, b) => a.top - b.top || b.height - a.height);
  let cluster: DayBlock[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const finish = () => {
    for (const block of cluster) block.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const block of blocks) {
    if (block.top >= clusterEnd) finish();
    let lane = laneEnds.findIndex((end) => end <= block.top);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = block.top + block.height;
    block.lane = lane;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.top + block.height);
  }
  finish();
  return blocks;
}

function mergeIntervals(intervals: [number, number][]): [number, number][] {
  const sorted = intervals.filter(([a, b]) => b > a).sort(([a], [b]) => a - b);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
