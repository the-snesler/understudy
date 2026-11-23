import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hub } from './core/hub.js';
import { HistoryStore } from './core/history.js';
import { LogBuffer, Logger, type LogLevel } from './core/log.js';
import { Controls } from './core/controls.js';
import { emptyConfig, Registry, type AppConfig } from './core/registry.js';
import { JsonStore, ScopedState } from './core/store.js';
import { plugins } from './plugins/index.js';
import { newSessionSecret, uiAuthFromEnv } from './web/auth.js';
import { createWebApp } from './web/app.js';

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || './data');
const port = Number(env.PORT || 8080);
const publicUrl = env.PUBLIC_URL?.replace(/\/+$/, '') || undefined;
// Before anything starts, so a bad DISABLE_AUTH value stops the app instead of running it unprotected.
const uiAuth = uiAuthFromEnv(env);
const uiPassword = uiAuth.mode === 'password' ? uiAuth.password : undefined;

const logs = new LogBuffer();
const log = new Logger(logs, 'app', (env.LOG_LEVEL as LogLevel) || 'info');

const config = new JsonStore<AppConfig>(path.join(dataDir, 'config.json'), emptyConfig);
const state = new JsonStore<Record<string, unknown>>(path.join(dataDir, 'state.json'), () => ({}));
const hub = new Hub();
const registry = new Registry({ plugins, config, state, hub, log, env: { publicUrl, dataDir } });
const history = new HistoryStore(path.join(dataDir, 'history.sqlite'), { retentionDays: registry.historyRetention() });
hub.attachHistory(history);
registry.attachHistory(history);

// Before the instances start, so outputs see a saved pause from the first state they get.
const controls = new Controls(new ScopedState(state, '_app'), hub, log.child('app'));
controls.start();

await registry.ensureInstances([
  { plugin: 'discord', enabled: true },
  { plugin: 'tautulli', enabled: true },
  { plugin: 'nintendo', enabled: true },
  { plugin: 'manual', enabled: true },
]);
await registry.startAll();

// Signs UI sessions; kept in state.json so sign-ins survive restarts.
const authState = new ScopedState<{ sessionSecret?: string }>(state, '_auth');
let sessionSecret = authState.get()?.sessionSecret;
if (uiPassword && !sessionSecret) {
  sessionSecret = newSessionSecret();
  await authState.set({ sessionSecret });
}

const preferences = new ScopedState<{ attentionDismissedAt?: number }>(state, '_ui');
const app = createWebApp({ registry, hub, logs, env: { publicUrl }, uiPassword, sessionSecret, controls, history, preferences });
const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info(`Web UI on http://localhost:${info.port} (data in ${dataDir})`);
  if (uiAuth.mode === 'disabled') {
    log.info('DISABLE_AUTH is set; the web UI expects whatever is in front of it (e.g. a reverse proxy) to authenticate.');
    if (uiAuth.passwordIgnored) log.warn('UI_PASSWORD is ignored because DISABLE_AUTH is set.');
  } else if (uiAuth.mode === 'open') {
    log.warn('UI_PASSWORD is not set; anyone who can reach the web UI can change settings. Set it, or set DISABLE_AUTH=true if a reverse proxy handles sign-in.');
  }
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close();
  controls.stop();
  await registry.stopAll();
  history.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
