import type { LogEntry } from '../../core/log.js';
import { LogTable } from '../components/events.js';
import { PageHeader } from '../components/page.js';
import { Layout } from '../layout.js';

export function LogPage({ entries }: { entries: LogEntry[] }) {
  return (
    <Layout title="Log">
      <PageHeader title="Log">
        <span class="small muted">Recent events from every source and output</span>
      </PageHeader>
      <div class="card log-table-wrapper"><LogTable entries={entries} /></div>
    </Layout>
  );
}
