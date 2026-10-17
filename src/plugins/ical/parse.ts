import ICAL from 'ical.js';
import type { ImportedEntry } from '../../core/history.js';
import { isValidTimeZone } from '../../core/schedule.js';

export interface ParsedCalendar {
  /** The calendar's own name (`X-WR-CALNAME`), if it has one. */
  name?: string;
  /** This is one of Understudy's own Calendar feeds; importing it would echo history back. */
  ownFeed: boolean;
  entries: ImportedEntry[];
  /** All-day events in the window, which are left out: they aren't time you spent on something. */
  allDay: number;
}

/** Recurrences far beyond any useful window are not expanded (e.g. an every-minute rule). */
const MAX_OCCURRENCES = 20_000;
/** A moved occurrence can land earlier than its original slot; keep looking a little past the window. */
const MOVED_SLACK_MS = 31 * 86_400_000;

/**
 * Expand an iCalendar file into timed occurrences starting within [from, to). Recurring events,
 * exceptions (RECURRENCE-ID), EXDATEs and cancellations are honoured. Times use the event's own
 * zone: a VTIMEZONE from the file, else its TZID as an IANA zone, else the calendar's
 * X-WR-TIMEZONE, else `fallbackZone`.
 */
export function calendarEntries(text: string, window: { from: number; to: number }, fallbackZone: string): ParsedCalendar {
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error(/<html|<!doctype/i.test(text) ? 'The link returned a web page, not a calendar. Use the calendar’s iCal (.ics) address.' : 'The link didn’t return an iCalendar file.');
  }
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text) as unknown[]);
  } catch (error) {
    throw new Error(`The calendar couldn’t be read: ${(error as Error).message}`);
  }
  const calendar = root.name === 'vcalendar' ? root : root.getFirstSubcomponent('vcalendar') ?? root;
  const declared = String(calendar.getFirstPropertyValue('x-wr-timezone') ?? '');
  const calendarZone = declared && isValidTimeZone(declared) ? declared : fallbackZone;
  const zones = new Map<string, ICAL.Timezone>();
  for (const component of calendar.getAllSubcomponents('vtimezone')) {
    const zone = new ICAL.Timezone(component);
    if (zone.tzid) zones.set(zone.tzid, zone);
  }

  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const component of calendar.getAllSubcomponents('vevent')) {
    // ical.js only resolves zones it was told about; attach the file's own VTIMEZONEs.
    for (const name of ['dtstart', 'dtend', 'recurrence-id', 'exdate', 'rdate']) {
      for (const property of component.getAllProperties(name)) {
        const zone = zones.get(String(property.getParameter('tzid') ?? ''));
        if (!zone) continue;
        for (const value of property.getValues()) if (value instanceof ICAL.Time) value.zone = zone;
      }
    }
    const event = new ICAL.Event(component);
    if (!event.uid) continue;
    if (event.isRecurrenceException()) exceptions.push(event);
    else masters.set(event.uid, event);
  }
  for (const exception of exceptions) {
    const master = masters.get(exception.uid);
    if (master) master.relateException(exception);
  }

  const result: ParsedCalendar = {
    ...(calendar.getFirstPropertyValue('x-wr-calname') ? { name: String(calendar.getFirstPropertyValue('x-wr-calname')) } : {}),
    ownFeed: /\/\/Understudy\/\//i.test(String(calendar.getFirstPropertyValue('prodid') ?? '')),
    entries: [],
    allDay: 0,
  };
  const add = (event: ICAL.Event, start: ICAL.Time, end: ICAL.Time, uid: string) => {
    if (start.isDate) {
      const at = epoch(start, event, 'dtstart', calendarZone);
      if (at < window.to && epoch(end, event, 'dtend', calendarZone) > window.from) result.allDay++;
      return;
    }
    // Understudy's own feed events (the no-echo rule), and cancelled occurrences.
    if (event.uid.endsWith('@understudy')) return;
    if (String(event.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return;
    const startedAt = epoch(start, event, 'dtstart', calendarZone);
    const endedAt = Math.max(startedAt, epoch(end, event, 'dtend', calendarZone));
    if (startedAt < window.from || startedAt >= window.to) return;
    const location = event.location?.trim();
    result.entries.push({
      uid,
      title: event.summary?.trim() || 'Busy',
      ...(location ? { subtitle: location } : {}),
      startedAt,
      endedAt,
    });
  };

  for (const event of masters.values()) {
    if (!event.isRecurring()) {
      add(event, event.startDate, event.endDate, event.uid);
      continue;
    }
    const iterator = event.iterator();
    for (let count = 0, next = iterator.next(); next && count < MAX_OCCURRENCES; next = iterator.next(), count++) {
      if (epoch(next, event, 'dtstart', calendarZone) >= window.to + MOVED_SLACK_MS) break;
      const details = event.getOccurrenceDetails(next);
      add(details.item, details.startDate, details.endDate, `${event.uid}/${details.recurrenceId.toICALString()}`);
    }
  }
  // Exceptions whose series isn't in the file (some servers publish them alone).
  for (const exception of exceptions) {
    if (!masters.has(exception.uid)) add(exception, exception.startDate, exception.endDate, `${exception.uid}/${exception.recurrenceId.toICALString()}`);
  }
  result.entries.sort((a, b) => a.startedAt - b.startedAt);
  return result;
}

/**
 * Epoch milliseconds for a time. ical.js handles UTC and VTIMEZONE-backed times; a TZID without a
 * VTIMEZONE (common: Google writes IANA names) arrives as floating, so resolve it with Intl.
 */
function epoch(time: ICAL.Time, event: ICAL.Event, property: 'dtstart' | 'dtend', calendarZone: string): number {
  if (time.zone && time.zone.tzid !== 'floating') return time.toUnixTime() * 1000;
  const tzid = String(event.component.getFirstProperty(property)?.getParameter('tzid')
    ?? event.component.getFirstProperty('dtstart')?.getParameter('tzid') ?? '');
  const zone = tzid && isValidTimeZone(tzid) ? tzid : calendarZone;
  return wallTimeToEpoch(time.year, time.month, time.day, time.isDate ? 0 : time.hour, time.isDate ? 0 : time.minute, time.isDate ? 0 : time.second, zone);
}

/** The instant a wall-clock time happens in an IANA zone (the later one when clocks go back). */
export function wallTimeToEpoch(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - at;
  };
  const first = wall - offset(wall);
  return wall - offset(first);
}
