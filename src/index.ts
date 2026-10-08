import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hub } from './core/hub.js';
import { LogBuffer, Logger, type LogLevel } from './core/log.js';
import { emptyConfig, Registry, type AppConfig } from './core/registry.js';
import { JsonStore } from './core/store.js';
import { plugins } from './plugins/index.js';
import { createWebApp } from './web/app.js';

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || './data');
const port = Number(env.PORT || 8080);
const publicUrl = env.PUBLIC_URL?.replace(/\/+$/, '') || undefined;

const logs = new LogBuffer();
const log = new Logger(logs, 'app', (env.LOG_LEVEL as LogLevel) || 'info');

const config = new JsonStore<AppConfig>(path.join(dataDir, 'config.json'), emptyConfig);
const state = new JsonStore<Record<string, unknown>>(path.join(dataDir, 'state.json'), () => ({}));
const hub = new Hub();
const registry = new Registry({ plugins, config, state, hub, log, env: { publicUrl } });

await registry.ensureInstances([
  { plugin: 'discord', enabled: true },
  { plugin: 'tautulli', enabled: true },
  { plugin: 'manual', enabled: true },
]);
await registry.startAll();

const app = createWebApp({ registry, hub, logs, env: { publicUrl }, uiPassword: env.UI_PASSWORD || undefined });
const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info(`Web UI on http://localhost:${info.port} (data in ${dataDir})`);
  if (!env.UI_PASSWORD) log.warn('UI_PASSWORD is not set; anyone who can reach the web UI can change settings.');
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close();
  await registry.stopAll();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
