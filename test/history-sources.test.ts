import { describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/core/history.js';
import type { OutputContext } from '../src/core/plugin.js';
import { statusObservations } from '../src/plugins/discord/status.js';
import { createFeedAccess } from '../src/plugins/feeds/shared.js';
import { calendarEntries, wallTimeToEpoch } from '../src/plugins/ical/parse.js';
import { addDays, calendarWeek, dayBounds, weekStart } from '../src/web/calendar.js';
import { quietLogger } from './helpers.js';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
X-WR-CALNAME:Classes
X-WR-TIMEZONE:America/Chicago
BEGIN:VTIMEZONE
TZID:Custom Standard Time
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0100
TZOFFSETTO:+0100
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:standup@example
DTSTART;TZID=America/Chicago:20261005T093000
DTEND;TZID=America/Chicago:20261005T094500
RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR
EXDATE;TZID=America/Chicago:20261007T093000
SUMMARY:Standup
LOCATION:Room 4
END:VEVENT
BEGIN:VEVENT
UID:standup@example
RECURRENCE-ID;TZID=America/Chicago:20261008T093000
DTSTART;TZID=America/Chicago:20261008T130000
DTEND;TZID=America/Chicago:20261008T131500
SUMMARY:Standup (moved)
END:VEVENT
BEGIN:VEVENT
UID:standup@example
RECURRENCE-ID;TZID=America/Chicago:20261009T093000
DTSTART;TZID=America/Chicago:20261009T093000
DTEND;TZID=America/Chicago:20261009T094500
STATUS:CANCELLED
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:custom@example
DTSTART;TZID=Custom Standard Time:20261006T090000
DTEND;TZID=Custom Standard Time:20261006T100000
SUMMARY:Abroad
END:VEVENT
BEGIN:VEVENT
UID:floating@example
DTSTART:20261006T200000
DTEND:20261006T210000
END:VEVENT
BEGIN:VEVENT
UID:holiday@example
DTSTART;VALUE=DATE:20261006
SUMMARY:Holiday
END:VEVENT
BEGIN:VEVENT
UID:abc@understudy
DTSTART:20261006T010000Z
DTEND:20261006T020000Z
SUMMARY:Echo
END:VEVENT
END:VCALENDAR`;

describe('iCal import', () => {
  const window = { from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-10-10T00:00:00Z') };

  it('expands recurrences with exceptions, cancellations and EXDATEs, in each event’s zone', () => {
    const parsed = calendarEntries(ICS, window, 'UTC');
    expect(parsed.name).toBe('Classes');
    expect(parsed.ownFeed).toBe(false);
    expect(parsed.allDay).toBe(1);
    expect(parsed.entries.map((entry) => [entry.uid, entry.title, new Date(entry.startedAt).toISOString()])).toEqual([
      ['standup@example/20261005T093000', 'Standup', '2026-10-05T14:30:00.000Z'],
      ['custom@example', 'Abroad', '2026-10-06T08:00:00.000Z'],
      ['standup@example/20261006T093000', 'Standup', '2026-10-06T14:30:00.000Z'],
      // A floating time without a title uses the calendar's X-WR-TIMEZONE, and reads as Busy.
      ['floating@example', 'Busy', '2026-10-07T01:00:00.000Z'],
      ['standup@example/20261008T093000', 'Standup (moved)', '2026-10-08T18:00:00.000Z'],
    ]);
    expect(parsed.entries[0]).toMatchObject({ subtitle: 'Room 4', endedAt: Date.parse('2026-10-05T14:45:00Z') });
  });

  it('recognises Understudy’s own feed and rejects web pages', () => {
    expect(calendarEntries(ICS.replace('Google Inc//Google Calendar 70.9054', 'Understudy//Activity history'), window, 'UTC').ownFeed).toBe(true);
    expect(() => calendarEntries('<!doctype html><html></html>', window, 'UTC')).toThrow(/web page/);
  });

  it('converts wall-clock times across clock changes', () => {
    expect(wallTimeToEpoch(2026, 11, 1, 1, 30, 0, 'America/Chicago')).toBe(Date.parse('2026-11-01T06:30:00Z'));
    expect(wallTimeToEpoch(2026, 7, 1, 12, 0, 0, 'Asia/Kathmandu')).toBe(Date.parse('2026-07-01T06:15:00Z'));
  });
});

describe('Discord status', () => {
  const session = (activities: object[], id = 's') => ({ session_id: id, status: 'online', activities });

  it('records your clients’ activities once each and never Understudy’s own', () => {
    const observed = statusObservations([
      session([{ type: 0, name: 'Hades II', details: 'Fighting', application_id: '1' }, { type: 4, name: 'Custom Status', state: 'hi' }]),
      session([{ type: 0, name: 'Hades II', details: 'In the hub', application_id: '1' }, { type: 2, name: 'Spotify', details: 'Song', state: 'Artist' }], 't'),
      session([{ type: 3, name: 'Plex', details: 'Movie', application_id: 'ours' }], 'u'),
    ], { applicationId: 'ours', kinds: ['playing', 'listening', 'watching'], ignore: [] });
    expect(observed).toEqual([
      { key: 'discord:playing:1', kind: 'playing', title: 'Hades II' },
      { key: 'discord:listening:Spotify:Song:Artist', kind: 'listening', title: 'Song', subtitle: 'Artist' },
    ]);
  });

  it('honours the kinds and ignore settings', () => {
    const sessions = [session([{ type: 0, name: 'Hades II' }, { type: 2, name: 'Spotify', details: 'Song' }])];
    expect(statusObservations(sessions, { kinds: ['playing'], ignore: [] }).map((item) => item.title)).toEqual(['Hades II']);
    expect(statusObservations(sessions, { kinds: ['playing', 'listening'], ignore: ['spotify'] }).map((item) => item.title)).toEqual(['Hades II']);
  });
});

describe('feed links', () => {
  function context(instanceId: string, legacy: string | undefined) {
    let state: Record<string, unknown> | undefined;
    return {
      instanceId,
      publicBase: `/public/${instanceId}`,
      log: quietLogger(),
      state: { get: () => state, set: async (value: Record<string, unknown> | undefined) => { state = value; } },
      history: { query: () => [], timeZone: () => 'UTC', label: (id: string) => id, legacyFeedToken: () => legacy },
    } as unknown as OutputContext<unknown>;
  }

  it('lets the first instance of each feed adopt the old app-wide token, and gives others their own', () => {
    const first = createFeedAccess(context('calendar-feed', 'old-token'), 'calendar-feed', { file: 'calendar.ics' });
    expect(first.valid('old-token')).toBe(true);
    expect(first.url('https://example.test/')).toBe('https://example.test/public/calendar-feed/calendar.ics?token=old-token');
    const second = createFeedAccess(context('calendar-feed-2', 'old-token'), 'calendar-feed', { file: 'calendar.ics' });
    expect(second.valid('old-token')).toBe(false);
    expect(second.valid(undefined)).toBe(false);
  });
});

describe('calendar dates', () => {
  it('finds weeks and local days, including 25-hour days', () => {
    expect(weekStart('2026-10-15')).toBe('2026-10-12');
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    const fall = dayBounds('2026-11-01', 'America/Chicago');
    expect(fall.endAt - fall.startAt).toBe(25 * 3_600_000);
    expect(dayBounds('2026-10-10', 'Pacific/Kiritimati').startAt).toBe(Date.parse('2026-10-09T10:00:00Z'));
  });

  it('lays overlapping sessions side by side and clips them to each day', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    const store = new HistoryStore(':memory:', { now: () => now, heartbeatIntervalMs: 0 });
    const at = (iso: string) => Date.parse(iso);
    store.recordSource('plex', { key: 'm', kind: 'watching', name: 'Plex', title: 'Late movie' }, at('2026-10-12T23:00:00Z'));
    store.recordSource('plex', null, at('2026-10-13T01:00:00Z'));
    store.recordSource('steam', { key: 'g', kind: 'playing', name: 'Steam', title: 'Game' }, at('2026-10-12T23:30:00Z'));
    store.recordSource('steam', null, at('2026-10-12T23:45:00Z'));
    const week = calendarWeek(store, 'UTC', '2026-10-13', now);
    const [monday, tuesday] = week.days;
    expect(monday!.activity.map((block) => [block.group.title, block.lane, block.lanes, block.continuesAfter])).toEqual([
      ['Late movie', 0, 2, true],
      ['Game', 1, 2, false],
    ]);
    expect(tuesday!.activity[0]).toMatchObject({ top: 0, continuesBefore: true, lanes: 1 });
    expect(tuesday!.totals.watching).toBe(3_600_000);
    expect(week.selected).toBe('2026-10-13');
    expect(week.days[2]!.isToday).toBe(true);
    store.close();
  });
});
