import type { Hono } from 'hono';
import { z } from 'zod';
import type { HistorySegment } from '../../core/history.js';
import { defineOutput, type HistoryReader, type OutputContext, type PanelProps } from '../../core/plugin.js';
import { groupSegments, type HistoryGroup } from '../../core/timeline.js';
import { calendarText, type CalendarEvent } from './ics.js';
import { createFeedAccess, FeedLinkCard } from './shared.js';

const DAY_MS = 86_400_000;
const CONTENT = { title: 'What to publish', description: 'Everything here comes from your history; nothing is sent anywhere until a calendar reads the link.' };

const configSchema = z.object({
  content: z.enum(['activity', 'displayed']).default('activity').meta({
    title: 'Publish', group: CONTENT, widget: 'segmented',
    labels: { activity: 'Everything sources saw', displayed: 'Only what outputs showed' },
    description: 'Outputs show one activity at a time, after the Hub’s rules; sources see everything, including activity that lost priority.',
  }),
  kinds: z.array(z.enum(['watching', 'listening', 'playing'])).default(['watching', 'listening', 'playing']).meta({
    title: 'Kinds', group: CONTENT, labels: { watching: 'Watching', listening: 'Listening', playing: 'Playing' },
  }),
  combine: z.boolean().default(true).meta({
    title: 'Combine back-to-back items', group: CONTENT,
    description: 'One event per album, binge or game night instead of one per track or episode. Items less than 5 minutes apart are combined.',
  }),
  includePaused: z.boolean().default(false).meta({
    title: 'Include paused time', group: CONTENT,
    description: 'Paused media becomes its own event, marked Paused.',
  }),
  pastDays: z.number().int().min(1).max(3650).default(30).meta({
    title: 'Days to include', group: CONTENT,
    description: 'Calendar apps download the whole feed on every refresh, so shorter feeds update faster.',
  }),
  calendarName: z.string().trim().max(100).default('Understudy').meta({
    title: 'Calendar name', group: CONTENT, description: 'Shown by calendar apps that use the feed’s own name.',
  }),
});

type Config = z.infer<typeof configSchema>;

const VERBS: Record<string, string> = { watching: 'Watching', listening: 'Listening', playing: 'Playing' };

/** Build the feed. Calendar events imported by history sources never get here (the no-echo rule). */
export function historyCalendar(history: HistoryReader, config: Config, at = Date.now()): string {
  const scope = config.content === 'displayed' ? 'output' : 'source';
  const segments = history.query({ scope, from: at - config.pastDays * DAY_MS, to: at })
    .filter((item) => item.kind !== 'event' && config.kinds.includes(item.kind) && (config.includePaused || !item.paused));
  const groups = config.combine ? groupSegments(segments) : groupSegments(segments, 0);
  const events: CalendarEvent[] = [];
  for (const group of groups) {
    const end = Math.min(group.endedAt ?? at, at);
    if (end <= group.startedAt) continue;
    events.push({
      uid: `${group.id}@understudy`,
      start: group.startedAt,
      end,
      updatedAt: group.endedAt ?? at,
      summary: group.title,
      description: describe(group, history),
      categories: [VERBS[group.kind] ?? group.kind],
    });
  }
  return calendarText(config.calendarName || 'Understudy', events);
}

function describe(group: HistoryGroup, history: HistoryReader): string {
  const paused = group.items.every((item) => item.paused);
  const lines = [
    group.subtitle,
    `${VERBS[group.kind] ?? group.kind} · ${history.label(group.sourceId)}${paused ? ' · Paused' : ''}`,
  ];
  if (group.items.length > 1) {
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: history.timeZone(), hour: '2-digit', minute: '2-digit' });
    lines.push('', ...group.items.map((item: HistorySegment) => `${clock.format(item.startedAt)}  ${item.title}${item.subtitle ? ` — ${item.subtitle}` : ''}`));
  }
  return lines.filter((line) => line !== undefined).join('\n');
}

function createCalendarFeed(ctx: OutputContext<Config>) {
  const access = createFeedAccess(ctx, 'calendar-feed', { file: 'calendar.ics' });
  return {
    start() {},
    stop() {},
    onState() {},
    status: () => access.status(),
    routes: (app: Hono) => access.routes(app),
    publicRoutes(app: Hono) {
      app.get('/calendar.ics', (c) => {
        const denied = access.guard(c);
        if (denied) return denied;
        c.header('Content-Type', 'text/calendar; charset=utf-8');
        c.header('Content-Disposition', 'inline; filename="understudy.ics"');
        return c.body(historyCalendar(ctx.history!, ctx.config));
      });
    },
    panel(props: PanelProps) {
      const url = access.url(props.origin);
      return (
        <FeedLinkCard
          access={access}
          props={props}
          title="Calendar link"
          description="Subscribe to it in Google Calendar (Other calendars → From URL), Apple Calendar or Outlook. Calendar apps refresh it every few hours."
          routeBase={ctx.routeBase}
          subscribe={url.startsWith('https:') ? { label: 'Open in calendar app', href: url.replace(/^https:/, 'webcal:') } : undefined}
        />
      );
    },
  };
}

export const calendarFeedPlugin = defineOutput({
  id: 'calendar-feed',
  name: 'Calendar feed',
  description: 'Publishes your history as a calendar you can subscribe to. Leaves out events imported from calendars, so it never echoes them back.',
  service: 'calendar',
  publishes: 'history',
  multiple: true,
  configSchema,
  create: createCalendarFeed,
});
