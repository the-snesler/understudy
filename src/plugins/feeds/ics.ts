/** iCalendar (RFC 5545) text helpers. */

export interface CalendarEvent {
  uid: string;
  start: number;
  end: number;
  /** When the event last changed, for DTSTAMP and LAST-MODIFIED. */
  updatedAt: number;
  summary: string;
  description?: string;
  categories?: string[];
}

export function calendarText(name: string, events: CalendarEvent[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Understudy//Activity history//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
  ];
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${icsTime(event.updatedAt)}`,
      `LAST-MODIFIED:${icsTime(event.updatedAt)}`,
      `DTSTART:${icsTime(event.start)}`,
      `DTEND:${icsTime(event.end)}`,
      `SUMMARY:${icsEscape(event.summary)}`,
      ...(event.description ? [`DESCRIPTION:${icsEscape(event.description)}`] : []),
      ...(event.categories?.length ? [`CATEGORIES:${event.categories.map(icsEscape).join(',')}`] : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldCalendarLine).join('\r\n') + '\r\n';
}

export function icsTime(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function icsEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

/** RFC 5545's 75-octet limit counts UTF-8 bytes and includes the continuation space. */
export function foldCalendarLine(line: string): string {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 75) {
      chunks.push(current);
      current = ' ';
      bytes = 1;
    }
    current += character;
    bytes += size;
  }
  chunks.push(current);
  return chunks.join('\r\n');
}
