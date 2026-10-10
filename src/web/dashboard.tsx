import { describeActivity, type NowPlaying } from '../core/activity.js';
import type { DailyStats, HistoryStore } from '../core/history.js';
import type { Hub } from '../core/hub.js';
import type { LogBuffer, LogEntry } from '../core/log.js';
import type { InstanceView, Registry } from '../core/registry.js';
import { historyFeedUrls } from './history.js';
import { Icon, PluginIcon } from './icons.js';
import { Health, timeAgo } from './layout.js';

export function Dashboard({ registry, hub, logs, history, origin, dismissedAt = 0 }: { registry: Registry; hub: Hub; logs: LogBuffer; history?: HistoryStore; origin: string; dismissedAt?: number }) {
  const views = registry.list();
  const issues = views.filter((view) => ['warning', 'error'].includes(view.status.health));
  const recentWarnings = logs.recent(500).filter((entry) => entry.at > dismissedAt && ['warn', 'error'].includes(entry.level));
  const attention = issues.length + recentWarnings.length;
  const setup = views.filter((view) => view.config.enabled && view.status.health === 'setup').length;
  const selection = hub.snapshot();
  const rules = registry.hubRules();
  return <div id="dashboard" hx-get="/partials/dashboard" hx-trigger="every 3s, instances-reordered from:body" hx-swap="outerHTML">
    <div class="page-header"><h1>Overview</h1><div class={`health-banner ${attention || setup ? 'attention-banner' : ''}`}><Icon name={attention || setup ? 'activity' : 'check'} size={17} />{attention ? `${attention} ${attention === 1 ? 'item needs' : 'items need'} attention` : setup ? `${setup} ${setup === 1 ? 'instance needs' : 'instances need'} setup` : 'All sources and outputs healthy'}</div></div>
    <div class="overview-grid"><div class="pipeline">
      <InstanceList views={views.filter((v) => v.plugin?.kind === 'source')} kind="source" hub={hub} />
      <section class="card hub-card"><div class="card-header"><div class="flex items-center gap-3"><span class="hub-icon"><Icon name="hub" size={18} /></span><h2>Hub</h2><span class="small muted">Picks one activity for every output</span></div><a class="small font-semibold" href="/settings/hub">Edit rules</a></div><div class="hub-body"><div class="hub-selected" title={selection.selectionReason}>{selection.selected ? <ActivityCard activity={selection.selected.activity} /> : <div class="flex items-center gap-4"><span class="activity-art"><Icon name="hub" size={30} /></span><div><h2>Nothing selected</h2><p class="muted small mt-2">{selection.selectionReason}</p></div></div>}</div><div class="hub-rules"><RuleRow icon="list" label="Pick" value="Priority, then most recent" /><RuleRow icon="pause" label="Paused media" value={{ hide: 'Hide', last: 'Show last', show: 'Show' }[rules.paused]} /><RuleRow icon="moon" label="Quiet hours" value={rules.quietHours || 'Off'} /><RuleRow icon="clock" label="Time zone" value={rules.timeZone} /></div></div></section>
      <InstanceList views={views.filter((v) => v.plugin?.kind === 'output')} kind="output" hub={hub} />
    </div><aside class="aside-column">
      <TodayCard stats={history?.today(rules.timeZone)} />
      <FeedsCard history={history} origin={origin} />
      <section class="card"><div class="flex items-center justify-between gap-3 mb-3"><h2>Needs attention</h2><a class="small" href="/log">Log</a></div>{!attention ? <p class="muted small">Nothing right now. Warnings and failed sign-ins show up here.</p> : <>{issues.map((view) => <div class="attention-item"><a href={`/instances/${view.config.id}`}>{view.label}</a><p class="muted">{view.status.message}</p></div>)}{recentWarnings.slice(0, 5).map((entry) => <div class="attention-item"><strong>{entry.scope}</strong><span class="muted small"> · {timeAgo(entry.at)}</span><p class="muted">{entry.message}</p></div>)}{!!recentWarnings.length && <form action="/attention/dismiss" method="post"><button class="btn small" name="through" value={String(Date.now())}>Dismiss log warnings</button></form>}</>}</section>
    </aside></div>
  </div>;
}
function RuleRow({ icon, label, value }: { icon: string; label: string; value: string }) { return <div class="rule-row"><Icon name={icon} size={17} /><span>{label}</span><strong>{value}</strong></div>; }
export function ToggleForm({ view, returnTo = '/' }: { view: InstanceView; returnTo?: string }) {
  return <form class="toggle-form" action={`/instances/${view.config.id}/${view.config.enabled ? 'disable' : 'enable'}`} method="post"><input type="hidden" name="return" value={returnTo} /><label class="switch"><input type="checkbox" aria-label={`${view.config.enabled ? 'Disable' : 'Enable'} ${view.label}`} checked={view.config.enabled} data-submit-on-change /><span class="switch-track" aria-hidden="true"></span></label><noscript><button class="btn small">{view.config.enabled ? 'Disable' : 'Enable'}</button></noscript></form>;
}
function InstanceList({ views, kind, hub }: { views: InstanceView[]; kind: 'source' | 'output'; hub: Hub }) {
  return <section class="card flush"><div class="card-header"><div class="section-heading"><h2>{kind === 'source' ? 'Sources' : 'Outputs'}</h2>{kind === 'source' && <span class="small muted">Highest priority first · drag to reorder</span>}</div><a href={`/instances/new?kind=${kind}`} class="small font-semibold">+ Add {kind}</a></div><div data-reorder-url={kind === 'source' ? '/instances/reorder' : undefined}>{!views.length && <div class="empty-state">No {kind}s yet. Add one to get started.</div>}{views.map((view, index) => {
    const activity = kind === 'source' ? hub.get(view.config.id)?.activity : undefined;
    const enabled = view.config.enabled;
    return <div class={`instance-row ${kind === 'output' ? 'output-row' : ''} ${!enabled ? 'off' : ''}`} data-instance-id={view.config.id}>
      {kind === 'source' && <details class="reorder-menu"><summary class="reorder-handle" aria-label={`Reorder ${view.label}`}><Icon name="grip" size={20} /></summary><div class="reorder-options"><button type="button" data-move="up" disabled={index === 0}><Icon name="arrow-up" size={14} />Move up</button><button type="button" data-move="down" disabled={index === views.length - 1}><Icon name="arrow-down" size={14} />Move down</button></div></details>}
      <PluginIcon plugin={view.config.plugin} /><div><a class="instance-name" href={`/instances/${view.config.id}`}>{view.label}</a><div class="instance-sub"><Health health={enabled ? view.status.health : 'idle'} message={enabled ? activity ? activity.paused ? 'Paused' : activity.kind === 'listening' ? 'Listening' : activity.kind === 'watching' ? 'Watching' : 'Playing' : view.status.message : 'Off'} /></div></div>
      <div class="instance-activity" title={activity ? describeActivity(activity) : view.status.message}>{enabled ? activity ? `${activity.title}${activity.subtitle ? ` · ${activity.subtitle}` : ''}` : kind === 'source' ? 'Not playing anything' : view.status.message : 'Not checking'}</div>
      <span class="checked-at" title={view.status.lastSuccessAt ? `Last success ${new Date(view.status.lastSuccessAt).toLocaleString()}` : 'No successful check yet'}>{enabled && view.status.lastSuccessAt ? timeAgo(view.status.lastSuccessAt) : '–'}</span><ToggleForm view={view} />
    </div>;
  })}</div></section>;
}
export function ActivityCard({ activity }: { activity: NowPlaying }) {
  const duration = activity.startedAt && activity.endsAt ? activity.endsAt - activity.startedAt : 0;
  const elapsed = activity.startedAt ? Math.max(0, Math.min(Date.now() - activity.startedAt, duration)) : 0;
  return <div class="activity-preview" title={describeActivity(activity)}><div class="activity-art">{activity.largeImage?.url.startsWith('https://') ? <img src={activity.largeImage.url} alt={activity.largeImage.text ?? ''} /> : <Icon name={activity.kind === 'listening' ? 'music' : activity.kind === 'playing' ? 'gamepad' : 'film'} size={28} />}</div><div class="min-w-0 flex-1"><div class={`activity-kind kind-${activity.kind}`}>{activity.kind} · {activity.name}</div><div class="activity-title">{activity.title}</div>{activity.subtitle && <div class="activity-subtitle">{activity.subtitle}</div>}{duration > 0 && !activity.paused && <div class="progress-row"><span>{clockDuration(elapsed)}</span><div class="progress-track"><span style={`width:${Math.min(100, elapsed / duration * 100)}%`}></span></div><span>{clockDuration(duration)}</span></div>}</div></div>;
}
function clockDuration(ms: number): string { return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`; }
export function durationLabel(ms: number): string { const minutes = Math.floor(ms / 60000); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`; }
function TodayCard({ stats }: { stats?: DailyStats }) {
  const total = (stats?.watching ?? 0) + (stats?.listening ?? 0) + (stats?.playing ?? 0);
  const categories = [['watching', 'Watching'], ['listening', 'Listening'], ['playing', 'Playing'], ['displayed', 'Displayed']] as const;
  return <section class="card"><div class="flex justify-between items-center"><h2>Today</h2><a class="small" href="/timeline">Timeline</a></div><div class="stats-bar" role="img" aria-label="Today's activity by kind">{categories.slice(0, 3).map(([key]) => <span style={`background:var(--color-${key});width:${total ? ((stats?.[key] ?? 0) / total) * 100 : 0}%`}></span>)}</div><div class="stats-grid">{categories.map(([key, label]) => <div><div class="stat-label"><i style={key === 'displayed' ? 'border:1px solid var(--ok)' : `background:var(--color-${key})`}></i>{label}</div><div class="stat-value">{durationLabel(stats?.[key] ?? 0)}</div></div>)}</div>{!stats && <p class="muted small mt-4">History recording is not available.</p>}</section>;
}
export function FeedsCard({ history, origin }: { history?: HistoryStore; origin: string }) {
  const urls = history && historyFeedUrls(origin, history.token());
  return <section class="card"><h2>History feeds</h2><p class="muted small mt-1">For calendars, bots and scripts.</p>{urls ? <>{[['Calendar', '/feed/history.ics', urls.calendar, 'calendar'], ['JSON', '/api/history.json', urls.json, 'activity']].map(([label, path, url, icon]) => <div class="feed-item"><Icon name={icon!} size={18} /><div><strong class="small">{label}</strong><code>{path}</code></div><button type="button" class="btn" data-copy={url} aria-label={`Copy ${label} feed link`}><Icon name="copy" size={14} />Copy</button></div>)}</> : <p class="muted small mt-4">Enable history storage to create feed links.</p>}</section>;
}
export function RecentEvents({ entries }: { entries: LogEntry[] }) { return <section class="card flush"><div class="card-header"><h2>Recent</h2><a class="small" href="/log">Log</a></div><div class="card-body">{entries.length ? entries.map((entry) => <div class="recent-event"><span class="muted">{timeAgo(entry.at)}</span><span>{entry.message}</span></div>) : <p class="muted small">No events yet.</p>}</div></section>; }
