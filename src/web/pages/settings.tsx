import type { HistoryStore } from '../../core/history.js';
import type { Registry } from '../../core/registry.js';
import { FeedsCard } from '../components/history.js';
import { Breadcrumb, PageHeader } from '../components/page.js';
import { Icon } from '../icons.js';
import { Layout, Notice } from '../layout.js';
import { HubSettings } from '../settings.js';

export function SettingsPage({
  registry,
  history,
  origin,
  notice,
}: {
  registry: Registry;
  history?: HistoryStore;
  origin: string;
  notice?: string;
}) {
  const message = notice === 'regenerated'
    ? 'New feed links created. Previous links no longer work.'
    : 'Settings saved.';

  return (
    <Layout title="Settings">
      <PageHeader title="Settings" />
      {notice && <Notice kind="ok">{message}</Notice>}
      <div class="plugin-grid">
        <div>
          <HubRulesLink />
          <RetentionForm retentionDays={registry.historyRetention()} />
          {history && <FeedAccessCard />}
        </div>
        <aside class="aside-column"><FeedsCard history={history} origin={origin} /></aside>
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

function FeedAccessCard() {
  return (
    <section class="card">
      <h2>Feed access</h2>
      <p class="muted small mt-1">
        Anyone with a feed link can read your history. Regenerating links revokes the old ones.
      </p>
      <form method="post" action="/settings/feeds/regenerate" class="mt-4">
        <button class="btn"><Icon name="restart" size={15} />Regenerate links</button>
      </form>
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
