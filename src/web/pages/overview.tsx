import { Dashboard, type DashboardProps } from '../dashboard.js';
import { Layout } from '../layout.js';

export function OverviewPage(props: DashboardProps) {
  return (
    <Layout title="Overview">
      <Dashboard {...props} />
    </Layout>
  );
}
