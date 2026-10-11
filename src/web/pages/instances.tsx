import type { HubRules } from '../../core/hub.js';
import type { LogEntry } from '../../core/log.js';
import type { PanelProps, Plugin } from '../../core/plugin.js';
import type { InstanceView, Registry } from '../../core/registry.js';
import { RecentEvents } from '../components/events.js';
import { InstanceActions } from '../components/instances.js';
import { Breadcrumb, PageHeader } from '../components/page.js';
import { SaveBar } from '../components/save-bar.js';
import { SettingsFields } from '../forms.js';
import { Icon, PluginIcon } from '../icons.js';
import { Health, Layout, Notice, timeAgo } from '../layout.js';
import { OutputRulesCard } from '../settings.js';

export interface InstancePageValues {
  errors?: Record<string, string>;
  values?: Record<string, unknown>;
  rulesValues?: Partial<HubRules>;
}

interface InstancePageProps extends InstancePageValues {
  registry: Registry;
  view: InstanceView;
  panelProps: PanelProps;
  entries: LogEntry[];
  values: Record<string, unknown>;
  notice?: string;
  error?: string;
}

export function InstancePage({
  registry,
  view,
  panelProps,
  entries,
  values,
  notice,
  error,
  errors,
  rulesValues,
}: InstancePageProps) {
  const plugin = view.plugin;
  const { pagePath } = panelProps;

  return (
    <Layout title={view.label}>
      <Breadcrumb
        items={[
          { label: 'Overview', href: '/' },
          { label: plugin?.kind === 'output' ? 'Outputs' : 'Sources' },
          { label: view.label },
        ]}
      />
      <InstanceHeader registry={registry} view={view} pagePath={pagePath} />
      {notice && <Notice kind="ok">{notice}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {errors && <Notice kind="error">Some settings are invalid; see below.</Notice>}
      <div class="plugin-grid">
        <div>
          {view.live?.instance.panel?.(panelProps)}
          {plugin && (
            <InstanceSettingsForm
              registry={registry}
              view={view}
              panelProps={panelProps}
              values={values}
              errors={errors}
              rulesValues={rulesValues}
            />
          )}
        </div>
        <aside
          class="aside-column"
          hx-get={`${pagePath}/live`}
          hx-trigger="every 3s"
          hx-swap="innerHTML"
        >
          <InstanceLiveBlock view={view} props={panelProps} entries={entries} />
        </aside>
      </div>
    </Layout>
  );
}

function InstanceHeader({
  registry,
  view,
  pagePath,
}: {
  registry: Registry;
  view: InstanceView;
  pagePath: string;
}) {
  const plugin = view.plugin;
  const id = view.config.id;

  return (
    <div class="page-header plugin-heading">
      <div class="plugin-title">
        <PluginIcon plugin={view.config.plugin} large />
        <div>
          <div class="plugin-title-line">
            <h1>{view.label}</h1>
            <span hx-get={`${pagePath}/status`} hx-trigger="every 3s" hx-swap="innerHTML">
              <Health health={view.status.health} message={view.status.message} pill />
            </span>
          </div>
          <p>
            {plugin?.kind === 'output' ? 'Output' : 'Source'} · {plugin?.name ?? view.config.plugin}
            {' · '}<code>{id}</code>
            {plugin?.kind === 'source' && (
              ` · priority ${registry.sources().findIndex((source) => source.id === id) + 1}`
            )}
          </p>
        </div>
      </div>
      <InstanceActions view={view} pagePath={pagePath} />
    </div>
  );
}

function InstanceSettingsForm({
  registry,
  view,
  panelProps,
  values,
  errors,
  rulesValues,
}: Pick<InstancePageProps, 'registry' | 'view' | 'panelProps' | 'values' | 'errors' | 'rulesValues'>) {
  const plugin = view.plugin!;
  const labelGroup = plugin.id === 'tautulli'
    ? 'Connection'
    : plugin.id === 'discord' ? 'Discord application' : 'Settings';
  const labelField = (
    <div class="field">
      <label for="instance-label" class="field-label">Label</label>
      <input
        id="instance-label"
        type="text"
        name="label"
        value={view.config.label ?? ''}
        placeholder={plugin.name}
      />
    </div>
  );
  const outputRules = plugin.kind === 'output' ? (
    <OutputRulesCard registry={registry} view={view} values={rulesValues} error={errors?._rules} />
  ) : undefined;
  const saveMessage = plugin.kind === 'output'
    ? 'Saving reconnects this output.'
    : 'Saving restarts this source.';
  const previewUrl = plugin.id === 'tautulli' && view.live
    ? `${view.routeBase}/template-preview`
    : undefined;

  return (
    <form
      class="settings-form"
      method="post"
      action={`${panelProps.pagePath}/settings`}
      data-save-message={saveMessage}
    >
      <SettingsFields
        schema={plugin.configSchema}
        values={values}
        errors={errors}
        previewUrl={previewUrl}
        context={view.live?.instance.formContext?.(panelProps)}
        groupExtras={{ [labelGroup]: labelField }}
        afterGroups={plugin.id === 'discord' ? { 'When to show': outputRules } : undefined}
      />
      {plugin.kind === 'output' && plugin.id !== 'discord' && outputRules}
      <SaveBar message={saveMessage} />
    </form>
  );
}

export function InstanceLiveBlock({
  view,
  props,
  entries,
}: {
  view: InstanceView;
  props: PanelProps;
  entries: LogEntry[];
}) {
  return (
    <>
      {view.live?.instance.live?.(props) ?? (
        <section class="card">
          <h2>Live status</h2>
          <p class="mt-3"><Health health={view.status.health} message={view.status.message} /></p>
          {view.status.lastSuccessAt && (
            <p class="muted small">Last success {timeAgo(view.status.lastSuccessAt)}</p>
          )}
        </section>
      )}
      <RecentEvents entries={entries} />
    </>
  );
}

export function AddInstancePage({
  kind,
  plugins,
}: {
  kind: 'source' | 'output';
  plugins: Plugin[];
}) {
  return (
    <Layout title={`Add ${kind}`}>
      <Breadcrumb items={[{ label: 'Overview', href: '/' }, { label: `Add ${kind}` }]} />
      <PageHeader title={`Add ${kind}`} />
      <div class="max-w-2xl">
        {plugins.length ? (
          plugins.map((plugin) => <AddPluginForm plugin={plugin} />)
        ) : (
          <section class="card">
            <p class="muted">All available {kind}s have been added.</p>
            <a href="/">Back to Overview</a>
          </section>
        )}
      </div>
    </Layout>
  );
}

function AddPluginForm({ plugin }: { plugin: Plugin }) {
  return (
    <form class="card flex items-center gap-4" method="post" action="/instances">
      <PluginIcon plugin={plugin.id} />
      <div class="flex-1">
        <h2>{plugin.name}</h2>
        <p class="muted small mt-1">{plugin.description}</p>
      </div>
      <button class="btn" name="plugin" value={plugin.id}>
        <Icon name="plus" size={15} />
        Add
      </button>
    </form>
  );
}
