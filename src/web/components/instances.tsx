import { describeActivity, type NowPlaying } from '../../core/activity.js';
import type { Hub } from '../../core/hub.js';
import type { PluginKind } from '../../core/plugin.js';
import type { InstanceView } from '../../core/registry.js';
import { Icon, PluginIcon } from '../icons.js';
import { Health, timeAgo } from '../layout.js';

export const KIND_NOUNS: Record<PluginKind, string> = { source: 'source', history: 'history source', output: 'output' };

export function ToggleForm({
  view,
  returnTo = '/',
}: {
  view: InstanceView;
  returnTo?: string;
}) {
  const action = view.config.enabled ? 'disable' : 'enable';
  const label = view.config.enabled ? 'Disable' : 'Enable';

  return (
    <form class="toggle-form" action={`/instances/${view.config.id}/${action}`} method="post">
      <input type="hidden" name="return" value={returnTo} />
      <label class="switch">
        <input
          type="checkbox"
          aria-label={`${label} ${view.label}`}
          checked={view.config.enabled}
          data-submit-on-change
        />
        <span class="switch-track" aria-hidden="true"></span>
      </label>
      <noscript><button class="btn small">{label}</button></noscript>
    </form>
  );
}

function ReorderMenu({
  label,
  index,
  total,
}: {
  label: string;
  index: number;
  total: number;
}) {
  return (
    <details class="reorder-menu">
      <summary class="reorder-handle" aria-label={`Reorder ${label}`}>
        <Icon name="grip" size={20} />
      </summary>
      <div class="reorder-options">
        <button type="button" data-move="up" disabled={index === 0}>
          <Icon name="arrow-up" size={14} />
          Move up
        </button>
        <button type="button" data-move="down" disabled={index === total - 1}>
          <Icon name="arrow-down" size={14} />
          Move down
        </button>
      </div>
    </details>
  );
}

function activityStatus(activity: NowPlaying): string {
  if (activity.paused) return 'Paused';
  if (activity.kind === 'listening') return 'Listening';
  if (activity.kind === 'watching') return 'Watching';
  return 'Playing';
}

function InstanceRow({
  view,
  kind,
  activity,
  index,
  total,
}: {
  view: InstanceView;
  kind: 'source' | 'output';
  activity?: NowPlaying;
  index: number;
  total: number;
}) {
  const enabled = view.config.enabled;
  const message = enabled
    ? activity ? activityStatus(activity) : view.status.message
    : 'Off';
  const description = enabled
    ? activity
      ? `${activity.title}${activity.subtitle ? ` · ${activity.subtitle}` : ''}`
      : kind === 'source' ? 'Not playing anything'
        : view.plugin?.kind === 'output' && view.plugin.publishes === 'history' ? 'Publishes your history at a secret link'
        : view.status.message
    : 'Not checking';
  const lastSuccess = view.status.lastSuccessAt;

  return (
    <div
      class={`instance-row ${kind === 'output' ? 'output-row' : ''} ${!enabled ? 'off' : ''}`}
      data-instance-id={view.config.id}
    >
      {kind === 'source' && <ReorderMenu label={view.label} index={index} total={total} />}
      <PluginIcon plugin={view.config.plugin} />
      <div>
        <a class="instance-name" href={`/instances/${view.config.id}`}>{view.label}</a>
        <div class="instance-sub">
          <Health health={enabled ? view.status.health : 'idle'} message={message} />
        </div>
      </div>
      <div
        class="instance-activity"
        title={activity ? describeActivity(activity) : view.status.message}
      >
        {description}
      </div>
      <span
        class="checked-at"
        title={lastSuccess
          ? `Last success ${new Date(lastSuccess).toLocaleString()}`
          : 'No successful check yet'}
      >
        {enabled && lastSuccess ? timeAgo(lastSuccess) : '–'}
      </span>
      <ToggleForm view={view} />
    </div>
  );
}

export function InstanceList({
  views,
  kind,
  hub,
}: {
  views: InstanceView[];
  kind: 'source' | 'output';
  hub: Hub;
}) {
  return (
    <section class="card flush">
      <div class="card-header">
        <div class="section-heading">
          <h2>{kind === 'source' ? 'Sources' : 'Outputs'}</h2>
          {kind === 'source' && (
            <span class="small muted">Highest priority first · drag to reorder</span>
          )}
        </div>
        <a href={`/instances/new?kind=${kind}`} class="small font-semibold">+ Add {kind}</a>
      </div>
      <div data-reorder-url={kind === 'source' ? '/instances/reorder' : undefined}>
        {!views.length && (
          <div class="empty-state">No {kind}s yet. Add one to get started.</div>
        )}
        {views.map((view, index) => (
          <InstanceRow
            view={view}
            kind={kind}
            activity={kind === 'source' ? hub.get(view.config.id)?.activity : undefined}
            index={index}
            total={views.length}
          />
        ))}
      </div>
    </section>
  );
}

/** History sources only add to history, so they sit apart from the Sources → Hub → Outputs flow. */
export function HistorySourceList({ views }: { views: InstanceView[] }) {
  return (
    <section class="card flush history-sources">
      <div class="card-header">
        <div>
          <h2>History sources</h2>
          <p class="muted small">Add past activity to your Calendar. Outputs never show it live.</p>
        </div>
        <a href="/instances/new?kind=history" class="small font-semibold">+ Add</a>
      </div>
      {views.length ? views.map((view) => (
        <div class={`compact-row ${view.config.enabled ? '' : 'off'}`} data-instance-id={view.config.id}>
          <PluginIcon plugin={view.config.plugin} />
          <div class="min-w-0">
            <a class="instance-name" href={`/instances/${view.config.id}`}>{view.label}</a>
            <div class="instance-sub" title={view.status.message}>
              <Health health={view.config.enabled ? view.status.health : 'idle'} message={view.config.enabled ? view.status.message : 'Off'} />
            </div>
          </div>
          <ToggleForm view={view} />
        </div>
      )) : (
        <div class="empty-state">
          Import calendar events, or record games Discord sees you playing.{' '}
          <a href="/instances/new?kind=history">Add a history source</a>
        </div>
      )}
    </section>
  );
}

export function InstanceActions({
  view,
  pagePath,
}: {
  view: InstanceView;
  pagePath: string;
}) {
  const plugin = view.plugin;
  const canTestConnection = ['tautulli', 'jellyfin', 'steam', 'scrobbler', 'trakt']
    .includes(plugin?.id ?? '');

  return (
    <div class="actions top">
      {view.live && (
        plugin?.id === 'discord' ? (
          <form method="post" action={`${view.routeBase}/resend`}>
            <button class="btn"><Icon name="send" size={15} />Re-send now</button>
          </form>
        ) : canTestConnection && (
          <form method="post" action={`${view.routeBase}/test`}>
            <input name="return" type="hidden" value={pagePath} />
            <button class="btn"><Icon name="zap" size={15} />Test connection</button>
          </form>
        )
      )}
      {!(plugin?.kind === 'output' && plugin.publishes === 'history') && (
        <form method="post" action={`${pagePath}/restart`}>
          <button class="btn"><Icon name="restart" size={15} />Restart</button>
        </form>
      )}
      <div class="btn">
        <span>Enabled</span>
        <ToggleForm view={view} returnTo={pagePath} />
      </div>
      <details class="menu">
        <summary class="btn icon-only" aria-label="More actions"><Icon name="ellipsis" /></summary>
        <div class="menu-popover">
          <form
            method="post"
            action={`${pagePath}/remove`}
            data-confirm={plugin?.kind === 'history'
              ? `Remove ${view.label}? Everything it added to your history is deleted too.`
              : `Remove ${view.label}? Its settings are deleted; recorded history stays.`}
          >
            <button class="btn danger">
              <Icon name="trash" size={15} />
              Remove {plugin ? KIND_NOUNS[plugin.kind] : 'instance'}
            </button>
          </form>
        </div>
      </details>
    </div>
  );
}
