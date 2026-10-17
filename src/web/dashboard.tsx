import type { HistoryStore } from '../core/history.js';
import type { Hub, HubRules, HubState } from '../core/hub.js';
import type { LogBuffer, LogEntry } from '../core/log.js';
import type { InstanceView, Registry } from '../core/registry.js';
import { ActivityCard } from './components/activity.js';
import { TodayCard } from './components/history.js';
import { HistorySourceList, InstanceList } from './components/instances.js';
import { PageHeader } from './components/page.js';
import { pausedMediaLabels, RuleRow } from './components/rules.js';
import { Icon } from './icons.js';
import { timeAgo } from './layout.js';

// Preserve the existing imports while the reusable components have dedicated modules.
export { ActivityCard } from './components/activity.js';
export { RecentEvents } from './components/events.js';
export { durationLabel } from './components/history.js';
export { ToggleForm } from './components/instances.js';

export interface DashboardProps {
  registry: Registry;
  hub: Hub;
  logs: LogBuffer;
  history?: HistoryStore;
  dismissedAt?: number;
}

export function Dashboard({
  registry,
  hub,
  logs,
  history,
  dismissedAt = 0,
}: DashboardProps) {
  const views = registry.list();
  const issues = views.filter((view) => ['warning', 'error'].includes(view.status.health));
  const recentWarnings = logs.recent(500).filter((entry) => (
    entry.at > dismissedAt && ['warn', 'error'].includes(entry.level)
  ));
  const attention = issues.length + recentWarnings.length;
  const setup = views.filter((view) => (
    view.config.enabled && view.status.health === 'setup'
  )).length;
  const selection = hub.snapshot();
  const rules = registry.hubRules();

  return (
    <div
      id="dashboard"
      hx-get="/partials/dashboard"
      hx-trigger="every 3s, instances-reordered from:body"
      hx-swap="outerHTML"
    >
      <PageHeader title="Overview">
        <HealthBanner attention={attention} setup={setup} />
      </PageHeader>
      <div class="overview-grid">
        <div class="pipeline">
          <InstanceList
            views={views.filter((view) => view.plugin?.kind === 'source')}
            kind="source"
            hub={hub}
          />
          <HubCard selection={selection} rules={rules} />
          <InstanceList
            views={views.filter((view) => view.plugin?.kind === 'output')}
            kind="output"
            hub={hub}
          />
        </div>
        <aside class="aside-column">
          <TodayCard stats={history?.today(rules.timeZone)} />
          <HistorySourceList views={views.filter((view) => view.plugin?.kind === 'history')} />
          <NeedsAttentionCard issues={issues} recentWarnings={recentWarnings} />
        </aside>
      </div>
    </div>
  );
}

function HealthBanner({ attention, setup }: { attention: number; setup: number }) {
  const message = attention
    ? `${attention} ${attention === 1 ? 'item needs' : 'items need'} attention`
    : setup
      ? `${setup} ${setup === 1 ? 'instance needs' : 'instances need'} setup`
      : 'All sources and outputs healthy';

  return (
    <div class={`health-banner ${attention || setup ? 'attention-banner' : ''}`}>
      <Icon name={attention || setup ? 'activity' : 'check'} size={17} />
      {message}
    </div>
  );
}

function HubCard({ selection, rules }: { selection: HubState; rules: HubRules }) {
  return (
    <section class="card hub-card">
      <div class="card-header">
        <div class="flex items-center gap-3">
          <span class="hub-icon"><Icon name="hub" size={18} /></span>
          <h2>Hub</h2>
          <span class="small muted">Picks one activity for every output</span>
        </div>
        <a class="small font-semibold" href="/settings/hub">Edit rules</a>
      </div>
      <div class="hub-body">
        <div class="hub-selected" title={selection.selectionReason}>
          {selection.selected ? (
            <ActivityCard activity={selection.selected.activity} />
          ) : (
            <div class="flex items-center gap-4">
              <span class="activity-art"><Icon name="hub" size={30} /></span>
              <div>
                <h2>Nothing selected</h2>
                <p class="muted small mt-2">{selection.selectionReason}</p>
              </div>
            </div>
          )}
        </div>
        <div class="hub-rules">
          <RuleRow icon="list" label="Pick" value="Priority, then most recent" />
          <RuleRow
            icon="pause"
            label="Paused media"
            value={pausedMediaLabels[rules.paused]}
          />
          <RuleRow icon="moon" label="Quiet hours" value={rules.quietHours || 'Off'} />
          <RuleRow icon="clock" label="Time zone" value={rules.timeZone} />
        </div>
      </div>
    </section>
  );
}

function NeedsAttentionCard({
  issues,
  recentWarnings,
}: {
  issues: InstanceView[];
  recentWarnings: LogEntry[];
}) {
  const attention = issues.length + recentWarnings.length;

  return (
    <section class="card">
      <div class="flex items-center justify-between gap-3 mb-3">
        <h2>Needs attention</h2>
        <a class="small" href="/log">Log</a>
      </div>
      {!attention ? (
        <p class="muted small">Nothing right now. Warnings and failed sign-ins show up here.</p>
      ) : (
        <>
          {issues.map((view) => (
            <div class="attention-item">
              <a href={`/instances/${view.config.id}`}>{view.label}</a>
              <p class="muted">{view.status.message}</p>
            </div>
          ))}
          {recentWarnings.slice(0, 5).map((entry) => (
            <div class="attention-item">
              <strong>{entry.scope}</strong>
              <span class="muted small"> · {timeAgo(entry.at)}</span>
              <p class="muted">{entry.message}</p>
            </div>
          ))}
          {!!recentWarnings.length && (
            <form action="/attention/dismiss" method="post">
              <button class="btn small" name="through" value={String(Date.now())}>
                Dismiss log warnings
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
