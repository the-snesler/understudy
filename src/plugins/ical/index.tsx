import type { Hono } from 'hono';
import { z } from 'zod';
import type { HistorySegment } from '../../core/history.js';
import { errorMessage } from '../../core/log.js';
import { defineHistorySource, type HistorySourceContext, type InstanceStatus } from '../../core/plugin.js';
import { Icon } from '../../web/icons.js';
import { localDate } from '../../web/calendar.js';
import { timeAgo } from '../../web/layout.js';
import { calendarEntries } from './parse.js';

const DAY_MS = 86_400_000;
const CALENDAR = { title: 'Calendar', description: 'Copies past events into your history, next to what you were watching, listening to and playing.' };

const configSchema = z.object({
  url: z.string().trim().default('').refine((value) => !value || /^(https?|webcal):\/\/\S+$/i.test(value), 'Use an https://, http:// or webcal:// address')
    .meta({
      title: 'Calendar address (iCal)', group: CALENDAR, secret: true, placeholder: 'https://…/basic.ics',
      description: 'Google Calendar: Settings → your calendar → Secret address in iCal format. iCloud: share the calendar as Public Calendar. Outlook: Settings → Shared calendars → Publish a calendar → ICS.',
    }),
  pastDays: z.number().int().min(1).max(3650).default(30).meta({
    title: 'Import the last (days)', group: CALENDAR,
    description: 'Events older than your history retention are left out too.',
  }),
  refreshMinutes: z.number().int().min(5).max(1440).default(30).meta({
    title: 'Check every (minutes)', group: CALENDAR,
  }),
});

type Config = z.infer<typeof configSchema>;

interface ImportSummary {
  at: number;
  count: number;
  added: number;
  updated: number;
  removed: number;
  allDay: number;
  name?: string;
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 20 * 1024 * 1024;

function createCalendar(ctx: HistorySourceContext<Config>) {
  const { config, log } = ctx;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let lastError: string | undefined;
  let checking = false;
  const read = () => (ctx.state.get() ?? {}) as { last?: ImportSummary };

  async function load(): Promise<string> {
    const url = config.url.replace(/^webcal:/i, 'https:');
    const response = await fetch(url, {
      headers: { Accept: 'text/calendar, */*;q=0.5', 'User-Agent': 'Understudy (+https://github.com/the-snesler/understudy)' },
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      redirect: 'follow',
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new Error(`The calendar server answered ${response.status}. The address may have been reset; copy it again.`);
    }
    if (!response.ok) throw new Error(`The calendar server answered ${response.status}`);
    if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('The calendar is larger than 20 MB');
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error('The calendar is larger than 20 MB');
    return text;
  }

  async function sync(): Promise<void> {
    if (!config.url) return;
    checking = true;
    try {
      const now = Date.now();
      const window = { from: now - config.pastDays * DAY_MS, to: now };
      const parsed = calendarEntries(await load(), window, ctx.timeZone());
      if (ctx.signal.aborted) return;
      if (parsed.ownFeed) {
        throw new Error('This is one of Understudy’s own Calendar feeds. Importing it would copy your history back into itself, so it is skipped.');
      }
      const result = ctx.history.importEntries(window, parsed.entries);
      const summary: ImportSummary = { at: Date.now(), count: parsed.entries.length, allDay: parsed.allDay, ...result, ...(parsed.name ? { name: parsed.name } : {}) };
      await ctx.state.set({ ...read(), last: summary });
      if (result.added || result.updated || result.removed) {
        log.info(`Imported ${parsed.entries.length} events (${result.added} new, ${result.updated} changed, ${result.removed} removed)`);
      }
      if (lastError) log.info('Calendar is readable again');
      lastError = undefined;
      ctx.reportSuccess?.();
    } catch (error) {
      if (ctx.signal.aborted) return;
      const message = errorMessage(error);
      if (message !== lastError) log.warn(`Could not import the calendar: ${message}`);
      lastError = message;
    } finally {
      checking = false;
    }
  }

  function schedule(delay: number) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = sync().finally(() => {
        if (!ctx.signal.aborted) schedule(config.refreshMinutes * 60_000);
      });
    }, delay);
  }

  return {
    start() {
      if (config.url) schedule(0);
    },
    async stop() {
      clearTimeout(timer);
      await running?.catch(() => undefined);
    },
    status(): InstanceStatus {
      const last = read().last;
      if (!config.url) return { health: 'setup', message: 'Add the calendar’s iCal address' };
      if (lastError) return { health: 'warning', message: lastError, lastSuccessAt: last?.at };
      if (!last) return { health: 'idle', message: 'Importing…' };
      return { health: 'ok', message: `${last.count} ${last.count === 1 ? 'event' : 'events'} from the last ${config.pastDays} days`, lastSuccessAt: last.at };
    },
    routes(app: Hono) {
      const back = `/instances/${ctx.instanceId}`;
      app.post('/refresh', async (c) => {
        await (running ?? Promise.resolve()).catch(() => undefined);
        running = sync();
        await running;
        return c.redirect(lastError ? `${back}?error=${encodeURIComponent(lastError)}` : `${back}?message=${encodeURIComponent('Calendar imported.')}`);
      });
      app.post('/clear', async (c) => {
        const removed = ctx.history.clear();
        await ctx.state.set({ ...read(), last: undefined });
        log.info(`Deleted ${removed} imported events`);
        const note = config.url ? ' They come back on the next import unless you remove the address or this source.' : '';
        return c.redirect(`${back}?message=${encodeURIComponent(`Deleted ${removed} imported ${removed === 1 ? 'event' : 'events'}.${note}`)}`);
      });
    },
    live() {
      const last = read().last;
      const recent = ctx.history.recent(6);
      return (
        <section class="card flush">
          <div class="card-header">
            <div><h2>Imported events</h2>{last?.name && <p class="muted small">From “{last.name}”</p>}</div>
            {last && <span class="small muted">checked {timeAgo(last.at)}</span>}
          </div>
          <div class="card-body">
            {lastError && <p class="field-error small">{lastError}</p>}
            {!config.url ? <p class="muted small">Add the calendar’s address, then save.</p>
              : !last ? <p class="muted small">{checking ? 'Importing…' : 'Not imported yet.'}</p>
              : <>
                <p class="small">{last.count} {last.count === 1 ? 'event' : 'events'} from the last {config.pastDays} days{last.allDay ? `; ${last.allDay} all-day ${last.allDay === 1 ? 'event' : 'events'} left out` : ''}.</p>
                {recent.length ? <RecentEntries items={recent} timeZone={ctx.timeZone()} /> : <p class="muted small">No timed events in that range.</p>}
              </>}
            <div class="actions mt-4">
              {config.url && <form method="post" action={`${ctx.routeBase}/refresh`}><button class="btn"><Icon name="restart" size={15} />Import now</button></form>}
              {!!recent.length && <form method="post" action={`${ctx.routeBase}/clear`} data-confirm="Delete every event imported from this calendar?"><button class="btn danger"><Icon name="trash" size={15} />Delete imported events</button></form>}
            </div>
          </div>
        </section>
      );
    },
  };
}

function RecentEntries({ items, timeZone }: { items: HistorySegment[]; timeZone: string }) {
  const format = (at: number) => new Date(at).toLocaleString('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <ul class="entry-list">
      {items.map((item) => (
        <li><a href={`/calendar?date=${localDate(item.startedAt, timeZone)}#entry-${item.id}`}><strong>{item.title}</strong></a><span class="muted small">{format(item.startedAt)}{item.subtitle ? ` · ${item.subtitle}` : ''}</span></li>
      ))}
    </ul>
  );
}

export const icalPlugin = defineHistorySource({
  id: 'ical',
  name: 'Calendar (iCal)',
  description: 'Imports past events from Google, Apple or Outlook calendars into your history. Never included in Calendar feeds, so subscribing to a feed can’t loop.',
  service: 'calendar',
  multiple: true,
  configSchema,
  create: createCalendar,
});
