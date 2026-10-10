import type { Hono } from 'hono';
import type { HistoryQuery, HistorySegment, HistoryStore } from '../core/history.js';

export interface HistoryRoutesOptions {
  timeZone: () => string;
  now?: () => number;
}

/** Register before UI authentication: calendars use the secret URL instead of a UI session. */
export function registerHistoryRoutes(app: Hono, history: HistoryStore, options: HistoryRoutesOptions): void {
  const now = options.now ?? Date.now;
  for (const route of ['/feed/history.ics', '/api/history.json']) {
    app.get(route, (c) => {
      c.header('Cache-Control', 'private, no-store');
      c.header('Referrer-Policy', 'no-referrer');
      if (!history.validToken(c.req.query('token'))) return c.json({ error: 'Unauthorized' }, 401);
      let query: HistoryQuery;
      try {
        query = historyQuery(c.req.query());
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
      const at = now();
      if (route.endsWith('.ics')) {
        c.header('Content-Type', 'text/calendar; charset=utf-8');
        c.header('Content-Disposition', 'inline; filename="understudy-history.ics"');
        return c.body(historyCalendar(history.query({ ...query, scope: 'source' }), at));
      }
      return c.json({
        generatedAt: at,
        timeZone: options.timeZone(),
        segments: history.query({ ...query, scope: 'source' }),
        outputSegments: history.query({ ...query, scope: 'output' }),
      });
    });
  }
}

function historyQuery(query: Record<string, string>): HistoryQuery {
  const parseTime = (name: string): number | undefined => {
    const value = query[name];
    if (value === undefined) return undefined;
    const at = /^-?\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (!Number.isSafeInteger(at)) throw new Error(`${name} must be an ISO date or epoch milliseconds.`);
    return at;
  };
  const from = parseTime('from');
  const to = parseTime('to');
  if (from !== undefined && to !== undefined && from >= to) throw new Error('from must be earlier than to.');
  return { from, to, sourceId: query.sourceId };
}

export function historyFeedUrls(origin: string, token: string): { calendar: string; json: string } {
  const base = origin.replace(/\/+$/, '');
  const encoded = encodeURIComponent(token);
  return { calendar: `${base}/feed/history.ics?token=${encoded}`, json: `${base}/api/history.json?token=${encoded}` };
}

/** IDs belong to stored intervals, so the same item retains its UID as its end time changes. */
export function historyCalendar(items: HistorySegment[], at = Date.now()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Understudy//Activity history//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Understudy history'];
  for (const item of items) {
    if (item.outputId !== undefined) continue;
    const end = Math.min(item.endedAt ?? at, at);
    if (end <= item.startedAt) continue;
    const description = [
      item.subtitle,
      `${item.kind[0]!.toUpperCase()}${item.kind.slice(1)} · ${item.sourceId}`,
      item.paused ? 'Paused' : undefined,
    ].filter(Boolean).join('\n');
    const updatedAt = item.endedAt ?? at;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.id}@understudy`,
      `DTSTAMP:${icsTime(updatedAt)}`,
      `LAST-MODIFIED:${icsTime(updatedAt)}`,
      `DTSTART:${icsTime(item.startedAt)}`,
      `DTEND:${icsTime(end)}`,
      `SUMMARY:${icsEscape(item.title)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldCalendarLine).join('\r\n') + '\r\n';
}

function icsTime(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsEscape(value: string): string {
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
