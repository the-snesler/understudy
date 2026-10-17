import type { DailyStats } from '../../core/history.js';

export const CATEGORIES = [
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
        <a class="small" href="/calendar">Calendar</a>
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
