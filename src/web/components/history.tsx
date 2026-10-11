import type { DailyStats, HistoryStore } from '../../core/history.js';
import { historyFeedUrls } from '../history.js';
import { Icon } from '../icons.js';

const CATEGORIES = [
  ['watching', 'Watching'],
  ['listening', 'Listening'],
  ['playing', 'Playing'],
  ['displayed', 'Displayed'],
] as const;

export function durationLabel(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
    : `${minutes}m`;
}

export function TodayCard({ stats }: { stats?: DailyStats }) {
  const total = (stats?.watching ?? 0) + (stats?.listening ?? 0) + (stats?.playing ?? 0);

  return (
    <section class="card">
      <div class="flex justify-between items-center">
        <h2>Today</h2>
        <a class="small" href="/timeline">Timeline</a>
      </div>
      <div class="stats-bar" role="img" aria-label="Today's activity by kind">
        {CATEGORIES.slice(0, 3).map(([key]) => (
          <span
            style={`background:var(--color-${key});width:${total ? ((stats?.[key] ?? 0) / total) * 100 : 0}%`}
          ></span>
        ))}
      </div>
      <div class="stats-grid">
        {CATEGORIES.map(([key, label]) => (
          <div>
            <div class="stat-label">
              <i
                style={key === 'displayed'
                  ? 'border:1px solid var(--ok)'
                  : `background:var(--color-${key})`}
              ></i>
              {label}
            </div>
            <div class="stat-value">{durationLabel(stats?.[key] ?? 0)}</div>
          </div>
        ))}
      </div>
      {!stats && <p class="muted small mt-4">History recording is not available.</p>}
    </section>
  );
}

function FeedLink({
  label,
  path,
  url,
  icon,
}: {
  label: string;
  path: string;
  url: string;
  icon: string;
}) {
  return (
    <div class="feed-item">
      <Icon name={icon} size={18} />
      <div>
        <strong class="small">{label}</strong>
        <code>{path}</code>
      </div>
      <button
        type="button"
        class="btn"
        data-copy={url}
        aria-label={`Copy ${label} feed link`}
      >
        <Icon name="copy" size={14} />
        Copy
      </button>
    </div>
  );
}

export function FeedsCard({
  history,
  origin,
}: {
  history?: HistoryStore;
  origin: string;
}) {
  const urls = history && historyFeedUrls(origin, history.token());

  return (
    <section class="card">
      <h2>History feeds</h2>
      <p class="muted small mt-1">For calendars, bots and scripts.</p>
      {urls ? (
        <>
          <FeedLink label="Calendar" path="/feed/history.ics" url={urls.calendar} icon="calendar" />
          <FeedLink label="JSON" path="/api/history.json" url={urls.json} icon="activity" />
        </>
      ) : (
        <p class="muted small mt-4">Enable history storage to create feed links.</p>
      )}
    </section>
  );
}
