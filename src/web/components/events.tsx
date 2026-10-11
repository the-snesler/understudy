import type { LogEntry } from '../../core/log.js';
import { timeAgo } from '../layout.js';

export function RecentEvents({ entries }: { entries: LogEntry[] }) {
  return (
    <section class="card flush">
      <div class="card-header">
        <h2>Recent</h2>
        <a class="small" href="/log">Log</a>
      </div>
      <div class="card-body">
        {entries.length ? (
          entries.map((entry) => (
            <div class="recent-event">
              <span class="muted">{timeAgo(entry.at)}</span>
              <span>{entry.message}</span>
            </div>
          ))
        ) : (
          <p class="muted small">No events yet.</p>
        )}
      </div>
    </section>
  );
}

export function LogTable({ entries }: { entries: LogEntry[] }) {
  if (!entries.length) return <p class="muted">Nothing logged yet.</p>;

  return (
    <table class="log">
      <tbody>
        {entries.map((entry) => (
          <tr class={`lvl-${entry.level}`}>
            <td title={new Date(entry.at).toISOString()}>{timeAgo(entry.at)}</td>
            <td>{entry.scope}</td>
            <td>{entry.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
