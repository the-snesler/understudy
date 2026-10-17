import { sharedSettingsSchema } from '../../core/shared-settings.js';
import type { Registry } from '../../core/registry.js';
import { Breadcrumb, PageHeader } from '../components/page.js';
import { SettingsFields } from '../forms.js';
import { Icon, PluginIcon } from '../icons.js';
import { Health, Layout, Notice } from '../layout.js';
import { HubSettings } from '../settings.js';

export function SettingsPage({
  registry,
  notice,
}: {
  registry: Registry;
  notice?: string;
}) {
  return (
    <Layout title="Settings">
      <PageHeader title="Settings" />
      {notice && <Notice kind="ok">Settings saved.</Notice>}
      <div class="plugin-grid">
        <div>
          <HubRulesLink />
          <form class="settings-form" action="/settings/shared" method="post">
            <SettingsFields schema={sharedSettingsSchema} values={registry.sharedSettings()} />
            <div class="mb-4">
              {!!registry.sharedSettings().tmdbKey && <label class="small"><input type="checkbox" name="clearTmdbKey" /> Remove the saved TMDB key</label>}
              <button class="btn primary mt-4">Save shared settings</button>
            </div>
          </form>
          <RetentionForm retentionDays={registry.historyRetention()} />
        </div>
        <aside class="aside-column"><ShareHistoryCard registry={registry} /></aside>
      </div>
    </Layout>
  );
}

function HubRulesLink() {
  return (
    <section class="card">
      <div class="flex items-center gap-3 mb-3">
        <span class="hub-icon"><Icon name="hub" size={18} /></span>
        <h2>Hub rules</h2>
      </div>
      <p class="muted small">Choose how paused media and quiet hours affect your activity.</p>
      <a class="btn mt-4" href="/settings/hub">Edit Hub rules</a>
    </section>
  );
}

function RetentionForm({ retentionDays }: { retentionDays: number }) {
  return (
    <form class="card" action="/settings/history" method="post">
      <h2>History retention</h2>
      <p class="muted small mt-1">
        Activity stays on this server. Older completed segments are deleted automatically.
      </p>
      <label class="mt-4" for="retention">Keep history for (days)</label>
      <input
        id="retention"
        name="retentionDays"
        type="number"
        min="1"
        max="3650"
        value={retentionDays}
        required
      />
      <button class="btn primary mt-4">Save retention</button>
    </form>
  );
}

/** Feeds are outputs; this points to them from where people used to find feed links. */
function ShareHistoryCard({ registry }: { registry: Registry }) {
  const feeds = registry.list().filter((view) => view.plugin?.kind === 'output' && view.plugin.publishes === 'history');
  const missing = registry.plugins().filter((plugin) => (
    plugin.kind === 'output' && plugin.publishes === 'history' && !feeds.some((view) => view.config.plugin === plugin.id)
  ));
  return (
    <section class="card">
      <h2>Share your history</h2>
      <p class="muted small mt-1">
        Calendar and JSON feeds are outputs. Each has its own secret link, which works only while
        the output is enabled.
      </p>
      {feeds.map((view) => (
        <a class="feed-item" href={`/instances/${view.config.id}`}>
          <PluginIcon plugin={view.config.plugin} />
          <div class="min-w-0">
            <strong class="small">{view.label}</strong>
            <div class="small"><Health health={view.config.enabled ? view.status.health : 'idle'} message={view.config.enabled ? view.status.message : 'Off'} /></div>
          </div>
        </a>
      ))}
      {missing.map((plugin) => (
        <form method="post" action="/instances" class="mt-3">
          <button class="btn w-full" name="plugin" value={plugin.id}><Icon name="plus" size={15} />Add {plugin.name}</button>
        </form>
      ))}
    </section>
  );
}

export interface HubRulesPageProps {
  registry: Registry;
  notice?: string;
  errors?: Record<string, string>;
  values?: Record<string, unknown>;
}

export function HubRulesPage({ registry, notice, errors, values }: HubRulesPageProps) {
  return (
    <Layout title="Hub rules">
      <Breadcrumb items={[{ label: 'Settings', href: '/settings' }, { label: 'Hub rules' }]} />
      <PageHeader title="Hub rules" />
      {notice && <Notice kind="ok">Rules saved.</Notice>}
      {errors && <Notice kind="error">Some rules are invalid; see below.</Notice>}
      <div class="max-w-3xl">
        <HubSettings registry={registry} errors={errors} values={values} />
      </div>
    </Layout>
  );
}
