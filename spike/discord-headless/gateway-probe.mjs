#!/usr/bin/env node
// Spike: can our OAuth2 token (scopes: openid sdk.social_layer_presence, which includes identify +
// gateway.connect + activities.read) connect to the Discord Gateway, and does it tell us about the
// user's *other* sessions (status, client type, activities)? That is what we'd need to copy
// multi-scrobbler's "only show presence when you're actually online somewhere" logic.
//
// Usage:
//   node gateway-probe.mjs                      # connect, log everything, Ctrl+C to stop
//   node gateway-probe.mjs --intents 0          # send an explicit intents value in IDENTIFY
//   node gateway-probe.mjs --status invisible   # after READY, try op 3 to set this connection's status
//
// While it runs, type a line + Enter to drop a timestamped NOTE into the log
// (e.g. "closed desktop app", "switched to idle"). Full payloads go to gateway-log.jsonl (gitignored).
//
// Zero dependencies; needs Node 22+ (global WebSocket). Reads OAuth tokens from ./state.json, written
// by `node headless-test.mjs login`.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.STATE_FILE || path.join(HERE, 'state.json');
const LOG_FILE = path.join(HERE, 'gateway-log.jsonl');
const GATEWAY = process.env.DISCORD_GATEWAY || 'wss://gateway.discord.gg/?v=10&encoding=json';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
if (args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

if (typeof WebSocket === 'undefined') {
  console.error('This needs a Node version with a global WebSocket (Node 22+).');
  process.exit(1);
}

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch (e) {
  console.error(`Could not read ${STATE_FILE}: ${e.message}. Run \`node headless-test.mjs login\` first.`);
  process.exit(1);
}
const oauth = state.oauth;
if (!oauth?.access_token) {
  console.error('No OAuth access token in state.json. Run `node headless-test.mjs login` first.');
  process.exit(1);
}
if (oauth.expires_at && oauth.expires_at < Date.now() + 60_000) {
  console.error('The access token has expired. Run `node headless-test.mjs refresh-token` first.');
  process.exit(1);
}

const log = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s`;
function record(kind, data) {
  log.write(JSON.stringify({ at: new Date().toISOString(), kind, data }) + '\n');
}
function say(msg) {
  console.log(`${stamp()}  ${msg}`);
}
record('START', { gateway: GATEWAY, args, scope: oauth.scope });

function describeActivity(a) {
  const bits = [`type=${a.type}`, JSON.stringify(a.name)];
  if (a.application_id) bits.push(`app=${a.application_id}`);
  if (a.platform) bits.push(`platform=${a.platform}`);
  if (a.details) bits.push(`details=${JSON.stringify(a.details)}`);
  return bits.join(' ');
}
function describeSessions(sessions) {
  if (!Array.isArray(sessions)) return `  (sessions field is ${JSON.stringify(sessions)})`;
  if (!sessions.length) return '  (no sessions)';
  return sessions
    .map((s) => {
      const client = s.client_info ? `${s.client_info.client}/${s.client_info.os}` : '?';
      const acts = (s.activities || []).map((a) => `\n        - ${describeActivity(a)}`).join('');
      return `  - ${s.session_id}  status=${s.status}  client=${client}${s.active ? '  active' : ''}${acts}`;
    })
    .join('\n');
}

let seq = null;
let heartbeatTimer = null;
let acked = true;
const ws = new WebSocket(GATEWAY);
const send = (op, d) => ws.send(JSON.stringify({ op, d }));

ws.addEventListener('open', () => say('socket open'));
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
  if (msg.s != null) seq = msg.s;

  switch (msg.op) {
    case 10: {
      // Hello: start heartbeating, then identify.
      const interval = msg.d.heartbeat_interval;
      say(`HELLO heartbeat_interval=${interval}`);
      setTimeout(() => {
        heartbeat();
        heartbeatTimer = setInterval(heartbeat, interval);
      }, Math.floor(interval * Math.random()));
      const identify = {
        token: `Bearer ${oauth.access_token}`,
        properties: { os: 'linux', browser: 'server-rpc-probe', device: 'server-rpc-probe' },
      };
      if (flag('intents') !== undefined) identify.intents = Number(flag('intents'));
      send(2, identify);
      say(`IDENTIFY sent (intents=${identify.intents ?? 'omitted'})`);
      return;
    }
    case 11:
      acked = true;
      return;
    case 1:
      heartbeat();
      return;
    case 7:
      say('RECONNECT requested by Discord; this probe just exits. Run it again.');
      record('OP7', msg.d);
      return shutdown(1);
    case 9:
      say(`INVALID SESSION (resumable=${msg.d}). Identify was rejected; see the close code below if one follows.`);
      record('OP9', msg.d);
      return;
    case 0:
      return onDispatch(msg.t, msg.d);
    default:
      say(`op ${msg.op}`);
      record(`OP${msg.op}`, msg.d);
  }
});

function heartbeat() {
  if (!acked) say('warning: previous heartbeat not acked');
  acked = false;
  send(1, seq);
}

function onDispatch(t, d) {
  record(t, d);
  switch (t) {
    case 'READY': {
      say(`READY. Top-level keys: ${Object.keys(d).sort().join(', ')}`);
      say(`  user: ${d.user?.username ?? '?'} (${d.user?.id ?? '?'})  session_id: ${d.session_id}`);
      if ('sessions' in d) say(`  sessions:\n${describeSessions(d.sessions)}`);
      else say('  READY has no `sessions` field.');
      for (const k of ['user_settings', 'user_settings_proto', 'presences', 'relationships', 'guilds']) {
        if (k in d) say(`  has ${k}${Array.isArray(d[k]) ? ` (${d[k].length})` : ''}`);
      }
      const want = flag('status');
      if (want) {
        say(`sending op 3 PRESENCE_UPDATE status=${want}`);
        send(3, { since: 0, activities: [], status: want, afk: false });
      }
      return;
    }
    case 'READY_SUPPLEMENTAL': {
      say(`READY_SUPPLEMENTAL. Keys: ${Object.keys(d).sort().join(', ')}`);
      return;
    }
    case 'SESSIONS_REPLACE': {
      say(`SESSIONS_REPLACE:\n${describeSessions(d)}`);
      return;
    }
    case 'PRESENCE_UPDATE': {
      const acts = (d.activities || []).map((a) => `\n        - ${describeActivity(a)}`).join('');
      say(`PRESENCE_UPDATE user=${d.user?.id} status=${d.status} client_status=${JSON.stringify(d.client_status)}${acts}`);
      return;
    }
    default:
      say(`event ${t}`);
  }
}

ws.addEventListener('close', (ev) => {
  say(`socket closed: code=${ev.code} reason=${JSON.stringify(ev.reason)}`);
  record('CLOSE', { code: ev.code, reason: ev.reason });
  if (ev.code === 4004) say('  4004 = authentication failed: the Bearer token was not accepted for the gateway.');
  if (ev.code === 4013 || ev.code === 4014) say('  invalid/disallowed intents: try --intents 0, or omit --intents.');
  shutdown(0);
});
ws.addEventListener('error', (ev) => say(`socket error: ${ev.message ?? ev.type}`));

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  record('NOTE', line.trim());
  say(`NOTE: ${line.trim()}`);
});

function shutdown(code) {
  clearInterval(heartbeatTimer);
  rl.close();
  // Close with 1000 so Discord ends this session right away instead of letting it time out.
  if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  log.end(() => process.exit(code));
}
process.on('SIGINT', () => {
  say('Ctrl+C: closing');
  shutdown(0);
});
say(`connecting to ${GATEWAY}; full payloads -> ${path.basename(LOG_FILE)}`);
