import { describeActivity, type NowPlaying } from '../../core/activity.js';
import { Icon } from '../icons.js';

export function ActivityCard({ activity }: { activity: NowPlaying }) {
  const duration = activity.startedAt && activity.endsAt
    ? activity.endsAt - activity.startedAt
    : 0;
  const elapsed = activity.startedAt
    ? Math.max(0, Math.min(Date.now() - activity.startedAt, duration))
    : 0;
  const icon = activity.kind === 'listening'
    ? 'music'
    : activity.kind === 'playing'
      ? 'gamepad'
      : 'film';

  return (
    <div class="activity-preview" title={describeActivity(activity)}>
      <div class="activity-art">
        {activity.largeImage?.url.startsWith('https://') ? (
          <img src={activity.largeImage.url} alt={activity.largeImage.text ?? ''} />
        ) : (
          <Icon name={icon} size={28} />
        )}
      </div>
      <div class="min-w-0 flex-1">
        <div class={`activity-kind kind-${activity.kind}`}>
          {activity.kind} · {activity.name}
        </div>
        <div class="activity-title">{activity.title}</div>
        {activity.subtitle && <div class="activity-subtitle">{activity.subtitle}</div>}
        {duration > 0 && !activity.paused && (
          <div class="progress-row">
            <span>{clockDuration(elapsed)}</span>
            <div class="progress-track">
              <span style={`width:${Math.min(100, elapsed / duration * 100)}%`}></span>
            </div>
            <span>{clockDuration(duration)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function clockDuration(ms: number): string {
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
}
