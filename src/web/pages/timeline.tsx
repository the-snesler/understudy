import { PageHeader } from '../components/page.js';
import { Icon } from '../icons.js';
import { Layout } from '../layout.js';

export function TimelinePage() {
  return (
    <Layout title="Timeline">
      <PageHeader title="Timeline" />
      <section class="card stub">
        <Icon name="activity" size={36} />
        <h2>Your activity, over time</h2>
        <p class="muted">
          Activity history is being recorded. The timeline view is coming next. Today’s totals
          and history feeds are available on the Overview.
        </p>
        <a class="btn" href="/">Back to Overview</a>
      </section>
    </Layout>
  );
}
