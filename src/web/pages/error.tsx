import { Layout, Notice } from '../layout.js';

export function ErrorPage({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <Layout title={title}>
      <Notice kind="error">{message}</Notice>
      <a href="/">Back</a>
    </Layout>
  );
}
