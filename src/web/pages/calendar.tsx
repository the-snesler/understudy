import type { HistoryKind } from '../../core/history.js';
import type { HistoryGroup } from '../../core/timeline.js';
import { addDays, parseDate, type CalendarDay, type CalendarWeek, type DayBlock } from '../calendar.js';
import { CATEGORIES, durationLabel } from '../components/history.js';
import { PageHeader } from '../components/page.js';
import { Icon } from '../icons.js';
import { Layout } from '../layout.js';

export interface CalendarProps {
  week: CalendarWeek;
  /** Source and output labels by id. */
  labels: Record<string, string>;
  retentionDays: number;
  historySources: number;
  available: boolean;
}

const VERBS: Record<HistoryKind, string> = { watching: 'Watching', listening: 'Listening', playing: 'Playing', event: 'Calendar event' };

export function CalendarPage(props: CalendarProps) {
  return (
    <Layout title="Calendar">
      <CalendarView {...props} />
    </Layout>
  );
}

/** The whole page body; re-rendered every minute so open sessions grow. */
export function CalendarView(props: CalendarProps) {
  const { week } = props;
  const selected = week.days.find((day) => day.date === week.selected)!;
  return (
    <div id="calendar" hx-get={`/partials/calendar?date=${week.selected}`} hx-trigger="every 60s" hx-swap="outerHTML">
      <PageHeader title="Calendar">
        <WeekNav week={week} />
      </PageHeader>
      {!props.available ? (
        <section class="card stub">
          <Icon name="calendar" size={36} />
          <h2>History isn’t available</h2>
          <p class="muted">The calendar shows recorded history, and history storage couldn’t be opened.</p>
        </section>
      ) : (
        <div class="calendar-layout">
          <div class="min-w-0">
            <WeekGrid week={week} labels={props.labels} />
            <p class="muted small calendar-footnote">
              Times are in {week.timeZone}, the Hub’s time zone. History is kept for {props.retentionDays} days
              (<a href="/settings">change</a>).
            </p>
          </div>
          <aside class="aside-column">
            {week.hasHistory ? <DayAgenda day={selected} week={week} labels={props.labels} /> : <FirstRun />}
            <WeekSummary week={week} />
            {!props.historySources && <HistorySourcesHint />}
          </aside>
        </div>
      )}
    </div>
  );
}

function WeekNav({ week }: { week: CalendarWeek }) {
  const first = parseDate(week.start)!;
  const last = parseDate(addDays(week.start, 6))!;
  const month = (m: number) => new Date(Date.UTC(2000, m - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const label = first.month === last.month
    ? `${month(first.month)} ${first.day} – ${last.day}, ${last.year}`
    : `${month(first.month)} ${first.day} – ${month(last.month)} ${last.day}, ${last.year}`;
  const inThisWeek = week.days.some((day) => day.isToday);
  return (
    <div class="calendar-nav">
      <a class="btn icon-only" href={`/calendar?date=${addDays(week.selected, -7)}`} aria-label="Previous week"><Icon name="chevron-left" size={17} /></a>
      <a class={`btn ${inThisWeek && week.selected === week.today ? 'is-current' : ''}`} href="/calendar">Today</a>
      <a class="btn icon-only" href={`/calendar?date=${addDays(week.selected, 7)}`} aria-label="Next week"><Icon name="chevron-right" size={17} /></a>
      <h2 class="week-label">{label}</h2>
      <form method="get" action="/calendar" class="date-jump">
        <label class="sr-only" for="calendar-date">Go to date</label>
        <input id="calendar-date" type="date" name="date" value={week.selected} max={addDays(week.today, 365)} data-submit-on-change />
        <noscript><button class="btn">Go</button></noscript>
      </form>
    </div>
  );
}

function clock(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(at);
}

function range(group: HistoryGroup, week: CalendarWeek): string {
  const end = group.endedAt;
  if (end === null) return `${clock(group.startedAt, week.timeZone)} – now`;
  if (end === group.startedAt) return clock(group.startedAt, week.timeZone);
  return `${clock(group.startedAt, week.timeZone)} – ${clock(end, week.timeZone)}`;
}

function blockTitle(group: HistoryGroup, week: CalendarWeek, labels: Record<string, string>): string {
  return [
    group.title,
    group.subtitle,
    `${range(group, week)} · ${VERBS[group.kind]} · ${labels[group.sourceId] ?? group.sourceId}`,
  ].filter(Boolean).join('\n');
}

const HOURS = Array.from({ length: 8 }, (_, index) => index * 3);

function WeekGrid({ week, labels }: { week: CalendarWeek; labels: Record<string, string> }) {
  return (
    <section class="card flush calendar-card" aria-label="Week">
      <div class="calendar-head">
        <div class="calendar-gutter" aria-hidden="true"></div>
        {week.days.map((day) => <DayHeading day={day} selected={day.date === week.selected} />)}
      </div>
      <div class="calendar-body">
        <div class="calendar-gutter" aria-hidden="true">
          {HOURS.map((hour) => <span style={`top:${(hour / 24) * 100}%`}>{String(hour).padStart(2, '0')}:00</span>)}
        </div>
        {week.days.map((day) => (
          <div class={`day-column ${day.isToday ? 'today' : ''} ${day.date === week.selected ? 'selected' : ''} ${day.isFuture ? 'future' : ''}`}>
            {day.displayed.map((span) => (
              <span class="displayed-rail" style={`top:${pct(span.top)};height:${pct(span.height)}`} title="Shown by an output"></span>
            ))}
            {day.events.map((block) => <Block block={block} day={day} week={week} labels={labels} />)}
            {day.activity.map((block) => <Block block={block} day={day} week={week} labels={labels} />)}
            {day.isToday && <span class="now-line" style={`top:${pct((week.now - day.startAt) / (day.endAt - day.startAt))}`} aria-hidden="true"></span>}
          </div>
        ))}
      </div>
    </section>
  );
}

function DayHeading({ day, selected }: { day: CalendarDay; selected: boolean }) {
  const { year, month, day: date } = parseDate(day.date)!;
  const weekday = new Date(Date.UTC(year, month - 1, date)).toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const active = day.totals.watching + day.totals.listening + day.totals.playing;
  return (
    <a
      class={`day-heading ${selected ? 'selected' : ''} ${day.isToday ? 'today' : ''}`}
      href={`/calendar?date=${day.date}`}
      aria-current={selected ? 'date' : undefined}
    >
      <span class="day-name">{weekday}</span>
      <strong class="day-number">{date}</strong>
      <span class="day-total">{active ? durationLabel(active) : '–'}</span>
    </a>
  );
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;

function Block({ block, day, week, labels }: { block: DayBlock; day: CalendarDay; week: CalendarWeek; labels: Record<string, string> }) {
  const { group } = block;
  const tall = block.height >= 55 / 1440;
  return (
    <a
      class={`cal-block cal-${group.kind} ${block.continuesBefore ? 'continues-before' : ''} ${block.continuesAfter ? 'continues-after' : ''} ${group.endedAt === null ? 'open' : ''}`}
      href={`/calendar?date=${day.date}#entry-${group.id}`}
      style={`top:${pct(block.top)};height:${pct(block.height)};left:${pct(block.lane / block.lanes)};width:${pct(1 / block.lanes)}`}
      title={blockTitle(group, week, labels)}
    >
      <span class="cal-block-title">{group.title}</span>
      {tall && <span class="cal-block-meta">{clock(Math.max(group.startedAt, day.startAt), week.timeZone)}</span>}
    </a>
  );
}

function DayAgenda({ day, week, labels }: { day: CalendarDay; week: CalendarWeek; labels: Record<string, string> }) {
  const { year, month, day: date } = parseDate(day.date)!;
  const heading = new Date(Date.UTC(year, month - 1, date)).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const shown = (group: HistoryGroup) => day.shown.some((item) => item.sourceId === group.sourceId &&
    item.startedAt < (group.endedAt ?? week.now) && (item.endedAt ?? week.now) > group.startedAt);
  return (
    <section class="card flush agenda" id="agenda">
      <div class="card-header">
        <div>
          <h2>{day.isToday ? `Today · ${heading}` : heading}</h2>
          <p class="muted small">{summaryLine(day)}</p>
        </div>
      </div>
      {day.groups.length ? (
        <ol class="agenda-list">
          {day.groups.map((group) => (
            <li class={`agenda-item agenda-${group.kind}`} id={`entry-${group.id}`}>
              <span class="agenda-time">{range(group, week)}</span>
              <div class="min-w-0">
                <div class="agenda-title"><i class={`kind-swatch swatch-${group.kind}`} aria-hidden="true"></i><strong>{group.title}</strong></div>
                {group.subtitle && <div class="agenda-subtitle">{group.subtitle}</div>}
                <div class="agenda-meta">
                  {VERBS[group.kind]} · <a href={`/instances/${group.sourceId}`}>{labels[group.sourceId] ?? group.sourceId}</a>
                  {group.kind !== 'event' && ` · ${durationLabel((group.endedAt ?? week.now) - group.startedAt)}`}
                  {shown(group) && <span class="shown-badge" title="An output showed this">Shown</span>}
                </div>
                {group.items.length > 1 && (
                  <details class="agenda-items">
                    <summary class="small">{group.items.length} items</summary>
                    <ol>
                      {group.items.map((item) => (
                        <li><span class="agenda-time">{clock(item.startedAt, week.timeZone)}</span> {item.title}{item.subtitle && <span class="muted"> · {item.subtitle}</span>}</li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div class="empty-state">{day.isFuture ? 'This day hasn’t happened yet.' : 'Nothing recorded on this day.'}</div>
      )}
    </section>
  );
}

function summaryLine(day: CalendarDay): string {
  const parts = CATEGORIES.slice(0, 3).filter(([key]) => day.totals[key]).map(([key, label]) => `${label} ${durationLabel(day.totals[key])}`);
  const events = day.groups.filter((group) => group.kind === 'event').length;
  if (events) parts.push(`${events} calendar ${events === 1 ? 'event' : 'events'}`);
  return parts.length ? parts.join(' · ') : 'No activity';
}

function WeekSummary({ week }: { week: CalendarWeek }) {
  return (
    <section class="card">
      <h2>This week</h2>
      <div class="stats-grid mt-4">
        {CATEGORIES.map(([key, label]) => (
          <div>
            <div class="stat-label">
              <i class={key === 'displayed' ? 'swatch-displayed' : `swatch-${key}`}></i>
              {label}
            </div>
            <div class="stat-value">{durationLabel(week.totals[key])}</div>
          </div>
        ))}
      </div>
      <p class="muted small mt-4">
        <i class="kind-swatch swatch-event" aria-hidden="true"></i> Calendar events aren’t counted. Overlapping activity of
        one kind counts once.
      </p>
    </section>
  );
}

function FirstRun() {
  return (
    <section class="card">
      <h2>Nothing recorded yet</h2>
      <p class="muted small mt-2">
        Activity appears here as your sources report it: what you watch, listen to and play, with what outputs
        showed. Add a history source to bring in calendar events or what Discord sees you doing.
      </p>
    </section>
  );
}

function HistorySourcesHint() {
  return (
    <section class="card">
      <h2>Fill in the gaps</h2>
      <p class="muted small mt-2">
        History sources add past activity here without ever showing it live: events from your calendar, or games
        Discord detects on your PC.
      </p>
      <a class="btn mt-4" href="/instances/new?kind=history"><Icon name="plus" size={15} />Add a history source</a>
    </section>
  );
}
