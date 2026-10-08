#!/usr/bin/env node
// Throwaway spike: does Discord's undocumented "headless sessions" presence API
// work with a self-made Discord app, and which activity features does it support?
//
// Zero dependencies. Node 18+ (built-in fetch, crypto, http, readline, util.parseArgs).
// Run `node headless-test.mjs --help` for usage.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

// Optional .env next to the script (KEY=value lines). Real environment variables win.
const ENV_FILE = env.ENV_FILE || path.join(HERE, '.env');
try {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (env[m[1]] === undefined && v !== '') env[m[1]] = v;
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn(`Could not read ${ENV_FILE}: ${e.message}`);
}

// ---------------------------------------------------------------- config ---

const API_BASE = (env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
const CFG = {
  clientId: (env.DISCORD_CLIENT_ID || '').trim(),
  clientId2: (env.DISCORD_CLIENT_ID_2 || '').trim(),
  clientSecret: (env.DISCORD_CLIENT_SECRET || env.CLIENT_SECRET || '').trim(),
  redirectUri: env.REDIRECT_URI || 'http://localhost:8787/callback',
  scopes: env.DISCORD_SCOPES || 'openid sdk.social_layer_presence',
  apiBase: API_BASE,
  authorizeUrl: env.DISCORD_AUTHORIZE_URL || 'https://discord.com/oauth2/authorize',
  tokenUrl: env.DISCORD_TOKEN_URL ||
    (env.DISCORD_API_BASE ? `${API_BASE}/oauth2/token` : 'https://discord.com/api/oauth2/token'),
  stateFile: env.STATE_FILE || path.join(HERE, 'state.json'),
  resultsFile: env.RESULTS_FILE || path.join(HERE, 'results.md'),
  listenHost: env.CALLBACK_LISTEN_HOST || '',
  timestampsAs: env.TIMESTAMPS_AS === 'number' ? 'number' : 'string',
  showSecrets: false,
};

const DEFAULT_IMAGE = 'https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg';
const DEFAULT_SMALL_IMAGE = 'https://image.tmdb.org/t/p/w92/qJ2tW6WMUDux911r6m7haRef0WH.jpg';
const SESSION_TTL_MS = 20 * 60 * 1000;
const PENDING_LOGIN_MAX_AGE_MS = 10 * 60 * 1000;

const HELP = `
Discord headless-sessions spike (throwaway test script)

USAGE
  node headless-test.mjs <command> [flags]

ENV
  DISCORD_CLIENT_ID      (required) Application ID of your Discord app (Public Client ON)
  DISCORD_CLIENT_ID_2    (optional) second app ID, used by the two-sessions experiment
  DISCORD_CLIENT_SECRET  (optional) use a confidential client instead of PKCE-only
  REDIRECT_URI           default http://localhost:8787/callback (must be registered in the portal)
  DISCORD_SCOPES         default "openid sdk.social_layer_presence"
  DISCORD_API_BASE       default https://discord.com/api/v10 (point at a mock for offline tests)
  DISCORD_AUTHORIZE_URL  default https://discord.com/oauth2/authorize
  DISCORD_TOKEN_URL      default https://discord.com/api/oauth2/token (or $DISCORD_API_BASE/oauth2/token)
  STATE_FILE             default ./state.json   (OAuth tokens + known session tokens; gitignored)
  RESULTS_FILE           default ./results.md   (experiment report)
  CALLBACK_LISTEN_HOST   default 127.0.0.1 (+ ::1). Set 0.0.0.0 to accept the redirect from another machine
  TIMESTAMPS_AS          "string" (default, like the reference extension) or "number"
  ENV_FILE               default ./.env next to the script (KEY=value lines; real env vars win)

COMMANDS
  login                  PKCE authorization-code flow. Starts a callback server on the REDIRECT_URI
                         port AND accepts a pasted redirected URL (or bare code) on stdin.
      --no-server        only accept paste
      --code <url|code>  finish a login started earlier (uses the saved PKCE verifier)
  auth-url               print a fresh authorize URL (does not save anything) - for checking
  pkce-selftest          verify PKCE against the RFC 7636 test vector, print a sample authorize URL
  whoami                 GET /oauth2/@me and /users/@me, print granted scopes
  refresh-token          use the refresh_token to get a new access token
  create [activity flags]               create a new headless session
  update [--session <ref>] [flags]      update a known session (default: most recent) by passing its token
  delete [--session <ref>]              delete one session (default: most recent)
  delete-all                            delete every session token this script knows about
  sessions                              list known session tokens
  experiments [--only a,b] [--skip c] [--list] [--image URL] [--small-image URL]
              [--burst-count 5] [--burst-interval 2000]
                         guided tests; answers + raw API results are appended to results.md
  keepalive [activity flags] [--interval-min 14] [--duration-min N]
                         create a session and refresh it every N minutes with its token,
                         logging whether the token stays the same. Ctrl+C deletes it.
  keepalive --no-refresh create once, send nothing else; press Enter when it disappears
                         from your profile to record the real expiry time.

ACTIVITY FLAGS (create / update / keepalive)
  --type <0-6>                 0 Playing, 1 Streaming, 2 Listening, 3 Watching, 5 Competing
  --name <text>                activity name (default "Headless test")
  --details <text>  --state <text>
  --large-image <url|key>  --large-text <text>  --small-image <url|key>  --small-text <text>
  --start <t>  --end <t>       ms epoch, seconds epoch, ISO date, "now", "now+30m", "-10m", "none"
  --button "Label|https://url" (repeatable, max 2)
  --button-format labels|objects
                               labels (default): buttons:["Label"], metadata:{button_urls:[url]}
                               objects: buttons:[{label,url}]
  --status-display-type <0|1|2>  0 name, 1 state, 2 details
  --app-id <id>                application_id of the activity (default DISCORD_CLIENT_ID)
  --platform <p>               default "desktop"
  --no-supported-platforms     omit supported_platforms:["desktop"]
  --extra '<json>'             shallow-merge arbitrary JSON into the activity
  --label <text>               local nickname for the session (for --session)

GLOBAL FLAGS
  --show-secrets               print OAuth tokens unredacted
  -h, --help

  --session <ref> accepts a label, a list index from "sessions", or a raw session token.
`;

// ----------------------------------------------------------------- utils ---

const useColor = process.stdout.isTTY && !env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = { dim: paint(2), bold: paint(1), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const nowIso = () => new Date().toISOString();
const fmtClock = (ms) => new Date(ms).toLocaleTimeString();
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};
const shortTok = (t) => (t ? `${String(t).slice(0, 10)}…(len ${String(t).length}, sha ${sha8(t)})` : String(t));
const fmtTs = (ms) => (CFG.timestampsAs === 'number' ? Math.floor(ms) : String(Math.floor(ms)));

function die(msg) {
  console.error(C.red(`Error: ${msg}`));
  process.exit(1);
}

function requireClientId() {
  if (!CFG.clientId) die('DISCORD_CLIENT_ID is not set. Export your application ID first.');
  if (!/^\d{15,22}$/.test(CFG.clientId)) die(`DISCORD_CLIENT_ID "${CFG.clientId}" does not look like a snowflake.`);
}

const SECRET_KEYS = new Set(['access_token', 'refresh_token', 'id_token', 'code', 'code_verifier', 'client_secret']);

// Deep-copy obj, replacing OAuth secrets (console) and optionally session tokens (report).
function redact(obj, { oauth = true, sessionTokens = false } = {}) {
  if (Array.isArray(obj)) return obj.map((v) => redact(v, { oauth, sessionTokens }));
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (oauth && SECRET_KEYS.has(k) && typeof v === 'string') out[k] = `<redacted ${v.length} chars>`;
    else if (sessionTokens && k === 'token' && typeof v === 'string') out[k] = shortTok(v);
    else out[k] = redact(v, { oauth, sessionTokens });
  }
  return out;
}

function parseTime(v, label) {
  if (v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === 'none' || s === '') return null;
  const rel = /^(now)?\s*([+-])\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s);
  if (s === 'now') return Date.now();
  if (rel) {
    const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[rel[4] || 'm'];
    return Date.now() + (rel[2] === '-' ? -1 : 1) * Number(rel[3]) * mult;
  }
  if (/^\d+$/.test(s)) return s.length <= 10 ? Number(s) * 1000 : Number(s);
  const d = Date.parse(v);
  if (!Number.isNaN(d)) return d;
  die(`cannot parse ${label} "${v}"`);
}

function int(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n)) die(`${label} must be an integer, got "${v}"`);
  return n;
}

// Flatten {a:{b:1}} -> {"a.b": 1} for comparing what we sent with what came back.
function flatten(obj, prefix = '', out = {}) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = obj;
  return out;
}

// ----------------------------------------------------------------- state ---

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(C.yellow(`Could not read ${CFG.stateFile}: ${e.message}`));
    return {};
  }
}
const STATE = loadState();
STATE.sessions ||= [];

function saveState() {
  const tmp = `${CFG.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(STATE, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CFG.stateFile);
}

function rememberSession(token, { label, activity, replaces } = {}) {
  const now = Date.now();
  let s = STATE.sessions.find((x) => x.token === (replaces || token));
  if (s && replaces && replaces !== token) {
    s.previous_tokens = [...(s.previous_tokens || []), replaces];
    s.token = token;
  }
  if (!s) {
    s = { token, label: label || `session-${STATE.sessions.length + 1}`, created_at: now };
    STATE.sessions.push(s);
  }
  s.updated_at = now;
  if (activity) s.activity = activity;
  saveState();
  return s;
}

function forgetSession(token) {
  STATE.sessions = STATE.sessions.filter((x) => x.token !== token);
  saveState();
}

function findSession(ref) {
  if (ref === undefined) return STATE.sessions[STATE.sessions.length - 1];
  if (/^\d{1,3}$/.test(ref)) return STATE.sessions[Number(ref)];
  return STATE.sessions.find((s) => s.label === ref) ||
    STATE.sessions.find((s) => s.token === ref) ||
    { token: ref, label: '(raw token)' };
}

// ------------------------------------------------------------ prompting ---

// Line-queue prompter: works with a TTY and with piped stdin (lines are never lost).
class Prompter {
  constructor() {
    this.tty = !!process.stdin.isTTY;
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: this.tty });
    this.rl.on('line', (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else this.lines.push(l);
    });
    this.rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
    this.rl.on('SIGINT', () => process.emit('SIGINT'));
  }

  // Resolves to the line, null on EOF, undefined if aborted.
  ask(q, signal) {
    this.rl.setPrompt(q);
    this.rl.prompt();
    const echo = (l) => {
      if (!this.tty && l != null) process.stdout.write(`${l}\n`);
      return l;
    };
    if (this.lines.length) return Promise.resolve(echo(this.lines.shift()));
    if (this.closed) return Promise.resolve(echo(null));
    return new Promise((resolve) => {
      const w = (l) => resolve(echo(l));
      this.waiters.push(w);
      signal?.addEventListener('abort', () => {
        this.waiters = this.waiters.filter((x) => x !== w);
        process.stdout.write('\n');
        resolve(undefined);
      }, { once: true });
    });
  }

  close() {
    this.rl.close();
  }
}
let prompter = null;
const getPrompter = () => (prompter ||= new Prompter());

// ---------------------------------------------------------- cleanup hooks ---

const cleanupHooks = [];
let exiting = false;
process.on('SIGINT', async () => {
  if (exiting) {
    console.log(C.red('\nSecond Ctrl+C: exiting without cleanup.'));
    process.exit(130);
  }
  exiting = true;
  console.log(C.yellow('\nCtrl+C: cleaning up (press Ctrl+C again to force quit)...'));
  for (const hook of cleanupHooks.splice(0).reverse()) {
    try {
      await hook();
    } catch (e) {
      console.error(C.red(`cleanup error: ${e.message}`));
    }
  }
  process.exit(130);
});

// ------------------------------------------------------------------ HTTP ---

let recorder = null; // when set (array), every call record is pushed into it
const RL_HEADER = /^(x-ratelimit-.*|retry-after)$/i;

function printRecord(rec) {
  const show = (v) => JSON.stringify(CFG.showSecrets ? v : redact(v), null, 2).replace(/\n/g, '\n    ');
  console.log(C.cyan(`→ ${rec.method} ${rec.url}`));
  if (rec.request !== undefined) console.log(`  request: ${show(rec.request)}`);
  const statusColor = rec.status >= 200 && rec.status < 300 ? C.green : C.red;
  console.log(statusColor(`← ${rec.status || 'NETWORK ERROR'} ${rec.statusText || ''}`) + C.dim(`  ${rec.ms} ms`));
  if (rec.error) console.log(C.red(`  error: ${rec.error}`));
  const rl = Object.entries(rec.rateLimit);
  if (rl.length) for (const [k, v] of rl) console.log(C.yellow(`  ${k}: ${v}`));
  else if (rec.status) console.log(C.dim('  (no X-RateLimit-* headers)'));
  if (rec.body !== undefined && rec.body !== '') console.log(`  response: ${show(rec.body)}`);
  else if (rec.status) console.log(C.dim('  response: (empty body)'));
}

async function request(method, url, opts = {}) {
  const { json, form, auth = false, retryOn401 = true, quiet = false } = opts;
  const headers = { 'User-Agent': 'discord-headless-spike/0.1 (throwaway test script)' };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  if (auth) headers.Authorization = `Bearer ${await getAccessToken()}`;

  const t0 = Date.now();
  const rec = {
    at: new Date(t0).toISOString(), method, url,
    path: url.startsWith(CFG.apiBase) ? url.slice(CFG.apiBase.length) : url,
    request: json ?? form, status: 0, statusText: '', rateLimit: {}, body: undefined, ms: 0,
  };
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30000) });
    rec.status = res.status;
    rec.statusText = res.statusText;
    for (const [k, v] of res.headers) if (RL_HEADER.test(k)) rec.rateLimit[k] = v;
    const text = await res.text();
    try {
      rec.body = text ? JSON.parse(text) : '';
    } catch {
      rec.body = text;
    }
  } catch (e) {
    rec.error = e.cause?.message ? `${e.message}: ${e.cause.message}` : e.message;
  }
  rec.ms = Date.now() - t0;
  if (!quiet) printRecord(rec);
  recorder?.push(rec);

  if (auth && rec.status === 401 && retryOn401 && STATE.oauth?.refresh_token) {
    console.log(C.yellow('401 -> refreshing the access token and retrying once'));
    await refreshAccessToken();
    return request(method, url, { ...opts, retryOn401: false });
  }
  return rec;
}

const ok = (rec) => rec.status >= 200 && rec.status < 300;

// ----------------------------------------------------------------- OAuth ---

function makePkce() {
  const verifier = b64url(crypto.randomBytes(64)); // 86 chars (RFC 7636: 43-128)
  return { verifier, challenge: pkceChallenge(verifier) };
}
const pkceChallenge = (verifier) => b64url(crypto.createHash('sha256').update(verifier).digest());

function buildAuthorizeUrl({ clientId, redirectUri, state, challenge }) {
  const u = new URL(CFG.authorizeUrl);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', CFG.scopes);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

function withClientAuth(form) {
  if (CFG.clientSecret) form.client_secret = CFG.clientSecret;
  return form;
}

function storeTokens(body, clientId) {
  const prev = STATE.oauth || {};
  const expiresIn = Number(body.expires_in || 604800);
  STATE.oauth = {
    client_id: clientId,
    access_token: body.access_token,
    refresh_token: body.refresh_token || prev.refresh_token || '',
    token_type: body.token_type,
    scope: body.scope,
    expires_in: expiresIn,
    obtained_at: nowIso(),
    expires_at: Date.now() + expiresIn * 1000,
  };
  saveState();
}

async function refreshAccessToken() {
  const o = STATE.oauth;
  if (!o?.refresh_token) die('No refresh_token saved. Run login again.');
  const rec = await request('POST', CFG.tokenUrl, {
    form: withClientAuth({ client_id: o.client_id || CFG.clientId, grant_type: 'refresh_token', refresh_token: o.refresh_token }),
  });
  if (!ok(rec) || !rec.body?.access_token) die(`refresh failed (HTTP ${rec.status}). Run login again.`);
  storeTokens(rec.body, o.client_id || CFG.clientId);
  console.log(C.green(`Access token refreshed. scope="${STATE.oauth.scope}", expires ${new Date(STATE.oauth.expires_at).toISOString()}`));
  return STATE.oauth.access_token;
}

async function getAccessToken() {
  const o = STATE.oauth;
  if (!o?.access_token) die('Not logged in. Run: node headless-test.mjs login');
  if (o.client_id && CFG.clientId && o.client_id !== CFG.clientId) {
    console.warn(C.yellow(`Warning: saved token belongs to app ${o.client_id}, DISCORD_CLIENT_ID is ${CFG.clientId}.`));
  }
  if (Date.now() > Number(o.expires_at || 0) - 60000 && o.refresh_token) {
    console.log(C.yellow('Access token expired or about to; refreshing first.'));
    return refreshAccessToken();
  }
  return o.access_token;
}

function parseCallbackInput(input) {
  const s = String(input).trim();
  if (/code=|error=/.test(s)) {
    const q = s.includes('?') ? s.slice(s.indexOf('?') + 1) : s;
    const p = new URLSearchParams(q.split('#')[0]);
    return { code: p.get('code'), state: p.get('state'), error: p.get('error'), errorDescription: p.get('error_description') };
  }
  return { code: s, state: null };
}

function startCallbackServer(redirectUri) {
  let u;
  try {
    u = new URL(redirectUri);
  } catch {
    return null;
  }
  const localNames = ['localhost', '127.0.0.1', '[::1]', '::1'];
  if (u.protocol !== 'http:' || (!localNames.includes(u.hostname) && !CFG.listenHost)) {
    console.log(C.dim(`(Redirect URI host ${u.host} is not local http; no callback server. Use paste. Set CALLBACK_LISTEN_HOST to force one.)`));
    return null;
  }
  const port = Number(u.port || 80);
  const hosts = CFG.listenHost ? [CFG.listenHost] : ['127.0.0.1', '::1'];
  const servers = [];
  let resolveFn;
  const promise = new Promise((r) => (resolveFn = r));
  const handler = (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (reqUrl.pathname !== u.pathname) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not the callback path');
      return;
    }
    const hasCode = reqUrl.searchParams.has('code');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      `<!doctype html><meta charset=utf-8><title>headless spike</title><body style="font-family:sans-serif">` +
      `<h2>${hasCode ? 'Got the code. You can close this tab and look at the terminal.' : 'No code in this request (see terminal).'}</h2>`,
    );
    resolveFn({ source: 'callback server', input: reqUrl.toString() });
  };
  let listening = 0;
  for (const host of hosts) {
    const srv = http.createServer(handler);
    srv.on('error', (e) => console.log(C.dim(`(callback server on ${host}:${port} not available: ${e.code || e.message})`)));
    srv.listen(port, host, () => {
      listening++;
      console.log(C.dim(`Callback server listening on http://${host.includes(':') ? `[${host}]` : host}:${port}${u.pathname}`));
    });
    servers.push(srv);
  }
  return { promise, close: () => servers.forEach((s) => s.close()), get listening() { return listening; } };
}

async function cmdLogin(f) {
  requireClientId();
  if (f.code) return completeLogin(f.code);

  const { verifier, challenge } = makePkce();
  const state = b64url(crypto.randomBytes(24));
  STATE.pending = { verifier, state, created_at: Date.now(), client_id: CFG.clientId, redirect_uri: CFG.redirectUri };
  saveState();
  const url = buildAuthorizeUrl({ clientId: CFG.clientId, redirectUri: CFG.redirectUri, state, challenge });

  console.log(`\n${C.bold('1. Open this URL in a browser that is logged in to Discord:')}\n`);
  console.log(`AUTHORIZE_URL ${url}\n`);
  console.log(C.bold('2. Approve. Discord redirects to'), CFG.redirectUri);
  console.log('   - If that page loads (same machine, or ssh -L 8787:localhost:8787), this script picks it up.');
  console.log('   - If it fails to load ("can\'t connect"), copy the FULL URL from the address bar and paste it below.');
  console.log(C.dim(`   (Saved the PKCE verifier; you can also finish later with: login --code '<url>')\n`));

  const server = f['no-server'] ? null : startCallbackServer(CFG.redirectUri);
  const ac = new AbortController();
  const P = getPrompter();
  const pasted = P.ask('Paste redirected URL or code (or wait for the callback): ', ac.signal).then((v) => {
    if (v === null && server) return new Promise(() => {}); // stdin closed: keep waiting on the server
    return { source: 'paste', input: v };
  });
  const winner = await Promise.race([server?.promise, pasted].filter(Boolean));
  ac.abort();
  server?.close();
  if (winner.input == null || winner.input === '') die('No URL/code received.');
  console.log(C.dim(`Received via ${winner.source}.`));
  await completeLogin(winner.input);
}

async function completeLogin(input) {
  const p = STATE.pending;
  if (!p) die('No pending login (no saved PKCE verifier). Run "login" first.');
  if (Date.now() - p.created_at > PENDING_LOGIN_MAX_AGE_MS) {
    console.warn(C.yellow('Warning: this login was started more than 10 minutes ago; the code may have expired.'));
  }
  const cb = parseCallbackInput(input);
  if (cb.error) die(`Discord returned error=${cb.error} ${cb.errorDescription || ''}`);
  if (!cb.code) die('No code found in the input.');
  if (cb.state && cb.state !== p.state) die('OAuth state mismatch: this URL does not belong to the current login attempt.');
  if (!cb.state) console.warn(C.yellow('(Bare code pasted: state not verified.)'));

  const rec = await request('POST', CFG.tokenUrl, {
    form: withClientAuth({
      client_id: p.client_id, grant_type: 'authorization_code', code: cb.code,
      redirect_uri: p.redirect_uri, code_verifier: p.verifier,
    }),
  });
  if (!ok(rec) || !rec.body?.access_token) {
    die(`token exchange failed (HTTP ${rec.status}). If it says invalid_client / client_secret missing, ` +
      'turn on "Public Client" in the portal or set DISCORD_CLIENT_SECRET.');
  }
  storeTokens(rec.body, p.client_id);
  delete STATE.pending;
  saveState();
  console.log(C.green(`\nLogged in. Tokens saved to ${CFG.stateFile}`));
  await cmdWhoami();
}

function scopeReport(scopeText, extraScopes = []) {
  const granted = new Set([...String(scopeText || '').split(/\s+/), ...extraScopes].filter(Boolean));
  const has = (s) => granted.has(s);
  return {
    granted: [...granted],
    activitiesWrite: has('activities.write'),
    umbrella: has('sdk.social_layer_presence'),
    usable: has('activities.write') || has('sdk.social_layer_presence'),
  };
}

async function cmdWhoami({ quiet = false } = {}) {
  const me = await request('GET', `${CFG.apiBase}/oauth2/@me`, { auth: true, quiet });
  const user = await request('GET', `${CFG.apiBase}/users/@me`, { auth: true, quiet });
  const report = scopeReport(STATE.oauth?.scope, Array.isArray(me.body?.scopes) ? me.body.scopes : []);
  if (!quiet) {
    console.log(`\n${C.bold('Token check')}`);
    console.log(`  token response scope : ${STATE.oauth?.scope}`);
    if (me.body?.scopes) console.log(`  /oauth2/@me scopes   : ${me.body.scopes.join(' ')}`);
    if (me.body?.application) console.log(`  application          : ${me.body.application.name} (${me.body.application.id})`);
    if (me.body?.expires) console.log(`  token expires        : ${me.body.expires}`);
    if (ok(user)) console.log(`  /users/@me           : ${user.body.username} (${user.body.id})`);
    else console.log(C.yellow(`  /users/@me           : HTTP ${user.status}. May need the "identify" scope ` +
      '(DISCORD_SCOPES="openid sdk.social_layer_presence identify"). Not needed for presence.'));
    console.log(`  activities.write     : ${report.activitiesWrite ? C.green('yes') : C.yellow('not listed')}`);
    console.log(`  sdk.social_layer_presence: ${report.umbrella ? C.green('yes') : C.yellow('not listed')}`);
    if (!report.usable) console.log(C.red('  Neither presence scope was granted; headless sessions will probably fail.'));
  }
  return { me, user, report };
}

// -------------------------------------------------------------- activity ---

function defaultActivity(over = {}) {
  return clean({
    application_id: CFG.clientId,
    platform: 'desktop',
    supported_platforms: ['desktop'],
    type: 0,
    name: 'Headless test',
    details: 'Testing headless sessions',
    timestamps: { start: fmtTs(Date.now()) },
    ...over,
  });
}

function clean(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) delete obj[k];
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      clean(v);
      if (!Object.keys(v).length) delete obj[k];
    }
  }
  return obj;
}

function parseButtons(list) {
  return (list || []).map((b) => {
    const i = b.indexOf('|');
    return i === -1 ? { label: b, url: undefined } : { label: b.slice(0, i), url: b.slice(i + 1) };
  });
}

function applyButtons(a, buttons, format = 'labels') {
  if (!buttons?.length) return a;
  if (format === 'objects') {
    a.buttons = buttons.map((b) => clean({ label: b.label, url: b.url }));
  } else {
    a.buttons = buttons.map((b) => b.label);
    const urls = buttons.map((b) => b.url).filter(Boolean);
    if (urls.length) a.metadata = { ...(a.metadata || {}), button_urls: urls };
  }
  return a;
}

// Apply CLI flags on top of a base activity (defaults for create, stored activity for update).
function activityFromFlags(f, base) {
  const a = structuredClone(base);
  const setOrDel = (obj, k, v) => {
    if (v === undefined) return;
    if (v === '' || v === null) delete obj[k];
    else obj[k] = v;
  };
  if (f.type !== undefined) a.type = int(f.type, '--type');
  setOrDel(a, 'name', f.name);
  setOrDel(a, 'details', f.details);
  setOrDel(a, 'state', f.state);
  if (f['status-display-type'] !== undefined) {
    setOrDel(a, 'status_display_type', f['status-display-type'] === '' ? '' : int(f['status-display-type'], '--status-display-type'));
  }
  setOrDel(a, 'application_id', f['app-id']);
  setOrDel(a, 'platform', f.platform);
  if (f['no-supported-platforms']) delete a.supported_platforms;
  a.assets ||= {};
  setOrDel(a.assets, 'large_image', f['large-image']);
  setOrDel(a.assets, 'large_text', f['large-text']);
  setOrDel(a.assets, 'small_image', f['small-image']);
  setOrDel(a.assets, 'small_text', f['small-text']);
  a.timestamps ||= {};
  const start = parseTime(f.start, '--start');
  const end = parseTime(f.end, '--end');
  if (start !== undefined) setOrDel(a.timestamps, 'start', start === null ? null : fmtTs(start));
  if (end !== undefined) setOrDel(a.timestamps, 'end', end === null ? null : fmtTs(end));
  if (f.button?.length) {
    delete a.buttons;
    if (a.metadata) delete a.metadata.button_urls;
    applyButtons(a, parseButtons(f.button), f['button-format']);
  }
  if (f.extra) {
    try {
      Object.assign(a, JSON.parse(f.extra));
    } catch (e) {
      die(`--extra is not valid JSON: ${e.message}`);
    }
  }
  for (const img of [a.assets.large_image, a.assets.small_image]) {
    if (img && img.length > 313) console.warn(C.yellow(`Warning: image string is ${img.length} chars; docs say max 313.`));
  }
  return clean(a);
}

// ------------------------------------------------------- session API calls ---

const createdThisRun = new Set();

// Create (no token) or update (token) a headless session. Tracks tokens in STATE.
async function sendSession(activity, { token, label } = {}) {
  const body = { activities: [activity] };
  if (token) body.token = token;
  const rec = await request('POST', `${CFG.apiBase}/users/@me/headless-sessions`, { json: body, auth: true });
  const newToken = ok(rec) ? rec.body?.token : undefined;
  const result = { rec, ok: !!newToken, token: newToken, sentToken: token, activity };
  if (newToken) {
    result.tokenChanged = token ? newToken !== token : undefined;
    rememberSession(newToken, { label, activity, replaces: token && STATE.sessions.some((s) => s.token === token) ? token : undefined });
    createdThisRun.add(newToken);
    if (token) {
      console.log(result.tokenChanged
        ? C.yellow(`Session token CHANGED on update: ${shortTok(token)} -> ${shortTok(newToken)}`)
        : C.green(`Session token unchanged on update (${shortTok(newToken)}).`));
    } else console.log(C.green(`Session token: ${newToken}`));
  } else if (ok(rec)) {
    console.log(C.yellow('2xx but no "token" in the response body.'));
  }
  return result;
}

async function deleteSession(token) {
  const url = `${CFG.apiBase}/users/@me/headless-sessions/delete`;
  let rec = await request('POST', url, { json: { token }, auth: true });
  const retryAfter = Number(rec.body?.retry_after);
  if (rec.status === 429 && retryAfter > 0 && retryAfter <= 60) {
    console.log(C.yellow(`Rate limited on delete; waiting ${retryAfter}s and retrying once.`));
    await sleep(retryAfter * 1000 + 250);
    rec = await request('POST', url, { json: { token }, auth: true });
  }
  if (ok(rec) || rec.status === 404 || rec.status === 400) {
    if (!ok(rec)) console.log(C.yellow(`Delete returned ${rec.status}; session probably already gone. Forgetting it.`));
    forgetSession(token);
    createdThisRun.delete(token);
  }
  return rec;
}

// --------------------------------------------------------- basic commands ---

async function cmdCreate(f) {
  requireClientId();
  const activity = activityFromFlags(f, defaultActivity());
  const r = await sendSession(activity, { label: f.label });
  if (r.ok) console.log(C.dim('Sessions expire after ~20 minutes. Use "update" to refresh, "delete" to remove.'));
  process.exitCode = r.ok ? 0 : 1;
}

async function cmdUpdate(f) {
  requireClientId();
  const s = findSession(f.session);
  if (!s) die('No known session. Create one first or pass --session <token>.');
  console.log(C.dim(`Updating ${s.label}: ${shortTok(s.token)}`));
  const activity = activityFromFlags(f, s.activity || defaultActivity());
  const r = await sendSession(activity, { token: s.token, label: f.label || s.label });
  if (!r.ok && [400, 404].includes(r.rec.status)) {
    console.log(C.yellow('Update rejected; the session has probably expired (forgetting it). Run "create" for a new one.'));
    if (s.label !== '(raw token)') forgetSession(s.token);
  }
  process.exitCode = r.ok ? 0 : 1;
}

async function cmdDelete(f) {
  const s = findSession(f.session);
  if (!s) die('No known session to delete.');
  console.log(C.dim(`Deleting ${s.label}: ${shortTok(s.token)}`));
  const rec = await deleteSession(s.token);
  process.exitCode = ok(rec) ? 0 : 1;
}

async function cmdDeleteAll() {
  const tokens = [...new Set(STATE.sessions.flatMap((s) => [s.token, ...(s.previous_tokens || [])]))];
  if (!tokens.length) return console.log('No known sessions.');
  for (const t of tokens) await deleteSession(t);
  console.log(`Done. ${STATE.sessions.length} session(s) still tracked.`);
}

function cmdSessions() {
  if (!STATE.sessions.length) return console.log('No known sessions.');
  STATE.sessions.forEach((s, i) => {
    const age = Date.now() - (s.updated_at || s.created_at);
    const stale = age > SESSION_TTL_MS ? C.yellow(' (last update >20 min ago: probably expired)') : '';
    console.log(`[${i}] ${s.label}  ${s.activity?.name ?? ''}  updated ${fmtElapsed(age)} ago${stale}\n    ${s.token}`);
  });
}

// ------------------------------------------------------------ report file ---

function appendResults(md) {
  if (!fs.existsSync(CFG.resultsFile)) {
    fs.writeFileSync(CFG.resultsFile, '# Discord headless sessions: spike results\n\n' +
      'Generated by headless-test.mjs. Session tokens are shortened; OAuth tokens never appear here.\n');
  }
  fs.appendFileSync(CFG.resultsFile, md);
}

const fence = (v) => `\`\`\`json\n${JSON.stringify(redact(v, { sessionTokens: true }), null, 2)}\n\`\`\``;

function renderCall(rec) {
  const rl = Object.entries(rec.rateLimit).map(([k, v]) => `\`${k}: ${v}\``).join(', ') || '_none_';
  let md = `**${rec.method} ${rec.path} → ${rec.status || 'network error'} ${rec.statusText || ''}** (${rec.ms} ms, ${rec.at})\n\n`;
  if (rec.error) md += `Error: \`${rec.error}\`\n\n`;
  md += `Rate-limit headers: ${rl}\n\n`;
  if (rec.request !== undefined) md += `Request:\n${fence(rec.request)}\n\n`;
  md += rec.body === undefined || rec.body === '' ? 'Response: _(empty)_\n\n' : `Response:\n${fence(rec.body)}\n\n`;
  return md;
}

function renderSection(ctx, n) {
  const statuses = ctx.calls.map((c) => c.status).join(', ') || '-';
  let md = `\n### ${n}. \`${ctx.exp.id}\`: ${ctx.exp.title}${ctx.interrupted ? ' (INTERRUPTED)' : ''}\n\n`;
  md += `_Run ${ctx.startedAt.toISOString()} · HTTP statuses: ${statuses}_\n\n`;
  if (ctx.notes.length) md += `**Observed automatically**\n\n${ctx.notes.map((s) => `- ${s}`).join('\n')}\n\n`;
  if (ctx.qa.length) {
    md += '**Your answers**\n\n';
    for (const { q, a } of ctx.qa) md += `- **Q:** ${q}\n  **A:** ${a === '' ? '_(blank)_' : a}\n`;
    md += '\n';
  }
  md += `<details><summary>Raw API calls (${ctx.calls.length})</summary>\n\n`;
  md += ctx.calls.map(renderCall).join('');
  md += '</details>\n';
  return md;
}

// ------------------------------------------------------------ experiments ---

// Compare the activity we sent with what the API echoed back.
function describeResult(ctx, what, r) {
  const rec = r.rec;
  if (!r.ok) {
    const msg = typeof rec.body === 'object' ? JSON.stringify(rec.body) : String(rec.body ?? rec.error ?? '');
    ctx.note(`${what}: REJECTED (HTTP ${rec.status}) ${msg.slice(0, 400)}`);
    if (rec.status === 429) ctx.rateLimited = true;
    return;
  }
  const parts = [`${what}: accepted (HTTP ${rec.status})`];
  if (r.sentToken) parts.push(r.tokenChanged ? 'token CHANGED' : 'token unchanged');
  const returned = Array.isArray(rec.body?.activities) ? rec.body.activities[0] : undefined;
  if (!returned) parts.push('response has no activities[0]');
  ctx.note(parts.join('; '));
  if (!returned) return;
  const sent = flatten(r.activity);
  const got = flatten(returned);
  const diffs = [];
  for (const [k, v] of Object.entries(sent)) {
    if (!(k in got)) diffs.push(`\`${k}\` dropped`);
    else if (JSON.stringify(got[k]) !== JSON.stringify(v)) diffs.push(`\`${k}\`: sent ${JSON.stringify(v)} → got ${JSON.stringify(got[k])}`);
  }
  const extra = Object.keys(got).filter((k) => !(k in sent));
  if (diffs.length) ctx.note(`${what}: differences in echoed activity: ${diffs.join('; ')}`);
  else ctx.note(`${what}: echoed activity matches what was sent`);
  if (extra.length) ctx.note(`${what}: extra fields returned: ${extra.map((k) => `\`${k}\`=${JSON.stringify(got[k])}`).join(', ')}`);
}

function newCtx(exp, P) {
  const ctx = { exp, calls: [], qa: [], notes: [], tokens: new Set(), startedAt: new Date() };
  const recorded = async (fn) => {
    const prev = recorder;
    recorder = ctx.calls;
    try {
      return await fn();
    } finally {
      recorder = prev;
    }
  };
  ctx.send = (what, activity, token) => recorded(async () => {
    const r = await sendSession(activity, { token, label: exp.id });
    if (r.token) ctx.tokens.add(r.token);
    describeResult(ctx, what, r);
    return r;
  });
  ctx.del = (token) => recorded(async () => {
    const rec = await deleteSession(token);
    if (ok(rec) || rec.status === 404 || rec.status === 400) ctx.tokens.delete(token);
    return rec;
  });
  ctx.ask = async (q) => {
    const a = await P.ask(`\n  ${C.bold('?')} ${q}\n    > `);
    ctx.qa.push({ q, a: a == null ? '_(no answer)_' : a.trim() });
    return a;
  };
  ctx.note = (s) => {
    ctx.notes.push(s);
    console.log(C.cyan(`  [observed] ${s}`));
  };
  ctx.pause = (msg) => P.ask(`\n  ${C.bold('>>')} ${msg} [Enter] `);
  ctx.look = () => console.log(C.bold('\n  Now look at your Discord profile from ANOTHER account/device (allow ~5-10 s).'));
  ctx.cleanup = async () => {
    for (const t of [...ctx.tokens]) await ctx.del(t);
  };
  return ctx;
}

const act = (over) => defaultActivity({ details: undefined, ...over });
const tsWindow = (startOffsetMin, endOffsetMin) => clean({
  start: startOffsetMin == null ? undefined : fmtTs(Date.now() + startOffsetMin * 60000),
  end: endOffsetMin == null ? undefined : fmtTs(Date.now() + endOffsetMin * 60000),
});

function buildExperiments(opt) {
  return [
    {
      id: 'baseline',
      title: 'Playing (type 0) with custom name "Plex"',
      desc: 'Baseline. Does the session show up at all, and does name "Plex" stick or get replaced by your app name?',
      async run(ctx) {
        const r = await ctx.send('create type 0 "Plex"', act({ type: 0, name: 'Plex', details: 'Baseline details line', state: 'Baseline state line' }));
        if (!r.ok) return;
        ctx.look();
        await ctx.ask('Is an activity shown on your profile at all? (y/n)');
        await ctx.ask('Exact title shown: "Playing Plex", or your application\'s name? (free text)');
        await ctx.ask('Are the details/state lines and an elapsed timer shown? Any icon? (free text)');
      },
    },
    {
      id: 'type-watching',
      title: 'Watching (type 3)',
      desc: 'Is type 3 accepted, and does it display "Watching Plex"?',
      async run(ctx) {
        const r = await ctx.send('create type 3', act({ type: 3, name: 'Plex', details: 'The Matrix (1999)', state: 'Sci-Fi · 2h 16m' }));
        if (!r.ok) return;
        ctx.look();
        await ctx.ask('What does the profile card say: "Watching Plex"? "Playing ..."? (exact text)');
        await ctx.ask('What short status appears in the member list / DM list? (exact text)');
      },
    },
    {
      id: 'type-listening',
      title: 'Listening (type 2)',
      desc: 'Is type 2 accepted, and does it display "Listening to Plex"?',
      async run(ctx) {
        const r = await ctx.send('create type 2', act({ type: 2, name: 'Plex', details: 'Bohemian Rhapsody', state: 'Queen' }));
        if (!r.ok) return;
        ctx.look();
        await ctx.ask('What does the profile card say: "Listening to Plex"? (exact text)');
        await ctx.ask('What short status appears in the member list / DM list? (exact text)');
      },
    },
    {
      id: 'status-display-type',
      title: 'status_display_type 0 / 1 / 2',
      desc: 'Controls which field the short status shows (0 name, 1 state, 2 details). Mostly visible in the ' +
        'member list / DM list, not the profile card. Each value gets a fresh session.',
      async run(ctx) {
        let prev;
        for (const v of [0, 1, 2]) {
          if (prev) await ctx.del(prev);
          const r = await ctx.send(`create status_display_type=${v}`, act({
            type: 3, name: 'Plex', details: 'DETAILS The Matrix', state: 'STATE Sci-Fi', status_display_type: v,
          }));
          if (!r.ok) continue;
          prev = r.token;
          ctx.look();
          await ctx.ask(`[status_display_type=${v}] Short status shown? ("Watching Plex" = name, "Watching STATE…" = state, ` +
            '"Watching DETAILS…" = details) (exact text)');
        }
      },
    },
    {
      id: 'external-image',
      title: 'External HTTPS image URLs as large_image / small_image',
      desc: `large_image=${opt.image}\n  small_image=${opt.smallImage}\n  Docs say headless sessions proxy external URLs automatically.`,
      async run(ctx) {
        const r = await ctx.send('create with external images', act({
          type: 3, name: 'Plex', details: 'The Matrix (1999)', state: 'external image test',
          assets: { large_image: opt.image, large_text: 'large_text: poster', small_image: opt.smallImage, small_text: 'small_text: Plex' },
        }));
        if (!r.ok) return;
        ctx.look();
        await ctx.ask('Does the LARGE image (poster) render? (y/n / describe)');
        await ctx.ask('Does the SMALL image render (bottom-right badge)? (y/n)');
        await ctx.ask('Hover tooltips (large_text / small_text) shown? (y/n/unsure)');
      },
    },
    {
      id: 'timestamps-end',
      title: 'timestamps.end in the future (progress bar / countdown?)',
      desc: 'start = 10 min ago, end = 20 min from now. Tried with Watching (3), then Listening (2).',
      async run(ctx) {
        let prev;
        for (const type of [3, 2]) {
          if (prev) await ctx.del(prev);
          const r = await ctx.send(`create type ${type} with start+end`, act({
            type, name: 'Plex', details: type === 3 ? 'The Matrix (1999)' : 'Bohemian Rhapsody',
            state: 'progress test', timestamps: tsWindow(-10, 20),
          }));
          if (!r.ok) continue;
          prev = r.token;
          ctx.look();
          await ctx.ask(`[type ${type}] Progress bar? "xx:xx left" countdown? "xx:xx elapsed"? Nothing? (free text)`);
        }
      },
    },
    {
      id: 'buttons',
      title: 'Buttons (two payload formats)',
      desc: 'A: buttons:["label",...] + metadata.button_urls (gateway format).  B: buttons:[{label,url}] (RPC format).\n' +
        '  You usually CANNOT see your own buttons; check from the other account.',
      async run(ctx) {
        const btns = [{ label: 'View on IMDb', url: 'https://www.imdb.com/title/tt0133093/' }, { label: 'Plex', url: 'https://www.plex.tv/' }];
        let prev;
        for (const fmt of ['labels', 'objects']) {
          if (prev) await ctx.del(prev);
          const a = applyButtons(act({ type: 3, name: 'Plex', details: 'The Matrix (1999)', state: `buttons format: ${fmt}` }), btns, fmt);
          const r = await ctx.send(`create buttons format=${fmt}`, a);
          if (!r.ok) continue;
          prev = r.token;
          ctx.look();
          await ctx.ask(`[${fmt}] Buttons visible from the other account? Do they open the right URLs? (free text)`);
        }
      },
    },
    {
      id: 'update-token',
      title: 'Update an existing session by passing its token',
      desc: 'Create v1, update to v2 with the token, then try a bogus token and a deleted token (to learn the error codes).',
      async run(ctx) {
        const base = { type: 3, name: 'Plex', state: 'update test' };
        const r1 = await ctx.send('create v1', act({ ...base, details: 'VERSION 1' }));
        if (!r1.ok) return;
        ctx.look();
        await ctx.ask('Shows "VERSION 1"? (y/n)');
        const r2 = await ctx.send('update to v2 with token', act({ ...base, details: 'VERSION 2' }), r1.token);
        if (r2.ok) {
          ctx.look();
          await ctx.ask('Did the SAME activity change to "VERSION 2" in place, or is there a second activity / flicker? (free text)');
        }
        const r3 = await ctx.send('update with a bogus token', act({ ...base, details: 'BOGUS TOKEN' }), 'bogus-token-from-spike');
        const live = r2.token || r1.token;
        await ctx.del(live);
        const r4 = await ctx.send('update with the just-deleted token', act({ ...base, details: 'DELETED TOKEN' }), live);
        if (r3.ok || r4.ok) {
          ctx.note('Some bogus/deleted-token updates returned a token (treated as a create?). See raw calls.');
          await ctx.ask('Is a "BOGUS TOKEN" or "DELETED TOKEN" activity visible now? (y/n)');
        }
      },
    },
    {
      id: 'two-sessions',
      title: 'Two sessions at once ("Plex" + "Nintendo Switch")',
      desc: 'A and B with the same application_id; then B with DISCORD_CLIENT_ID_2 (if set), which tests whether the activity ' +
        'application_id must match the OAuth app.',
      async run(ctx) {
        const A = await ctx.send('create A "Plex"', act({ type: 3, name: 'Plex', details: 'The Matrix (1999)', state: 'session A' }));
        const B = await ctx.send('create B "Nintendo Switch" (same app)', act({ type: 0, name: 'Nintendo Switch', details: 'Mario Kart 8 Deluxe', state: 'session B' }));
        if (A.ok || B.ok) {
          ctx.look();
          await ctx.ask('Both activities shown? Only one (which)? (free text)');
        }
        if (!CFG.clientId2) {
          ctx.note('DISCORD_CLIENT_ID_2 not set: skipped the second-application_id part.');
          return;
        }
        if (B.ok) await ctx.del(B.token);
        const B2 = await ctx.send(`create B with application_id=${CFG.clientId2} (second app)`, act({
          application_id: CFG.clientId2, type: 0, name: 'Nintendo Switch', details: 'Mario Kart 8 Deluxe', state: 'session B (app 2)',
        }));
        if (B2.ok) {
          ctx.look();
          await ctx.ask('With B on the second app: both shown? Which name/icon does B use? (free text)');
        }
      },
    },
    {
      id: 'invisible',
      title: 'Visibility while your status is Invisible',
      desc: 'You will switch your own status to Invisible, then back to Online.',
      async run(ctx) {
        await ctx.pause('Set YOUR status to Invisible in Discord now, then press Enter.');
        const r = await ctx.send('create while invisible', act({ type: 3, name: 'Plex', details: 'Invisible test', state: 'should I be hidden?' }));
        if (!r.ok) return;
        ctx.look();
        await ctx.ask('While Invisible: is the activity visible to the other account? Do you appear online? (free text)');
        await ctx.pause('Now set your status back to Online, then press Enter.');
        await ctx.ask('After switching to Online (no new API call): visible now? (y/n)');
        await ctx.send('update after going Online', act({ type: 3, name: 'Plex', details: 'Invisible test (updated)', state: 'back online' }), r.token);
        await ctx.ask('After an update: visible? (y/n)');
      },
    },
    {
      id: 'rate-limit',
      title: `Quick-fire updates (${opt.burstCount} updates, ${opt.burstInterval} ms apart; stops on 429)`,
      desc: 'Looks for rate limits. X-RateLimit-* headers are summarised below.',
      async run(ctx) {
        const base = { type: 3, name: 'Plex', state: 'rate limit test' };
        const r = await ctx.send('create', act({ ...base, details: 'burst 0' }));
        if (!r.ok) return;
        let token = r.token;
        const rows = [];
        for (let i = 1; i <= opt.burstCount; i++) {
          await sleep(opt.burstInterval);
          const u = await ctx.send(`update ${i}/${opt.burstCount}`, act({ ...base, details: `burst ${i}/${opt.burstCount}` }), token);
          const h = u.rec.rateLimit;
          rows.push(`#${i}: HTTP ${u.rec.status}, remaining=${h['x-ratelimit-remaining'] ?? '?'}, ` +
            `limit=${h['x-ratelimit-limit'] ?? '?'}, reset-after=${h['x-ratelimit-reset-after'] ?? '?'}, bucket=${h['x-ratelimit-bucket'] ?? '?'}`);
          if (u.rec.status === 429) {
            ctx.note(`429 at update ${i}: retry_after=${u.rec.body?.retry_after}, global=${u.rec.body?.global}. Stopped.`);
            break;
          }
          if (u.token) token = u.token;
        }
        ctx.note(`Burst summary: ${rows.join(' | ')}`);
        ctx.look();
        await ctx.ask(`Did the profile end on the last successful "burst N/${opt.burstCount}" value? Did it visibly step through updates? (free text)`);
      },
    },
  ];
}

async function cmdExperiments(f) {
  requireClientId();
  const opt = {
    image: f.image || DEFAULT_IMAGE,
    smallImage: f['small-image'] || DEFAULT_SMALL_IMAGE,
    burstCount: Math.min(int(f['burst-count'] ?? 5, '--burst-count'), 20),
    burstInterval: Math.max(int(f['burst-interval'] ?? 2000, '--burst-interval'), 250),
  };
  let list = buildExperiments(opt);
  if (f.list) {
    list.forEach((e, i) => console.log(`${String(i + 1).padStart(2)}. ${e.id.padEnd(20)} ${e.title}`));
    return;
  }
  const only = f.only?.split(',').map((s) => s.trim()).filter(Boolean);
  const skip = f.skip?.split(',').map((s) => s.trim()).filter(Boolean) || [];
  const unknown = [...(only || []), ...skip].filter((id) => !list.some((e) => e.id === id));
  if (unknown.length) die(`unknown experiment id(s): ${unknown.join(', ')} (see --list)`);
  list = list.filter((e) => (!only || only.includes(e.id)) && !skip.includes(e.id));

  await getAccessToken();
  const P = getPrompter();
  console.log(C.bold('\nGuided experiments'));
  console.log('For each test the script sends requests, then asks what you see. Check your profile from a SECOND');
  console.log('Discord account (or a friend). Your own client may hide or cache things. Answers can be y/n or free text.');
  console.log(`Results are appended to ${CFG.resultsFile}. Ctrl+C deletes this run's sessions and saves what was done.\n`);

  const who = await cmdWhoami({ quiet: true });
  const viewer = await P.ask('How will you check? (e.g. "alt account, desktop app, profile popout + member list"): ');
  appendResults(`\n## Experiment run ${nowIso()}\n\n` +
    `- DISCORD_CLIENT_ID: \`${CFG.clientId}\`${CFG.clientId2 ? `, DISCORD_CLIENT_ID_2: \`${CFG.clientId2}\`` : ''}\n` +
    `- API base: \`${CFG.apiBase}\` · timestamps sent as ${CFG.timestampsAs}s · Node ${process.version}\n` +
    `- Granted scopes: \`${who.report.granted.join(' ')}\` (token: HTTP ${who.me.status} on /oauth2/@me, ${who.user.status} on /users/@me)\n` +
    `- Viewer: ${viewer?.trim() || '_(not given)_'}\n` +
    `- Tests: ${list.map((e) => e.id).join(', ')}\n`);

  const done = [];
  let current = null;
  const writeSummary = () => {
    let md = '\n#### Summary of this run\n\n| # | test | HTTP statuses | answers |\n|---|---|---|---|\n';
    done.forEach(({ ctx, n, skipped }) => {
      const answers = skipped ? '_skipped_' : ctx.qa.map((x) => String(x.a).replace(/\|/g, '/').slice(0, 80)).join(' · ');
      md += `| ${n} | ${skipped ? ctx : ctx.exp.id} | ${skipped ? '' : ctx.calls.map((c) => c.status).join(' ')} | ${answers} |\n`;
    });
    appendResults(md);
  };
  cleanupHooks.push(async () => {
    if (current) {
      current.ctx.interrupted = true;
      await current.ctx.cleanup();
      appendResults(renderSection(current.ctx, current.n));
      done.push(current);
    }
    writeSummary();
    console.log(`Partial results written to ${CFG.resultsFile}`);
  });

  for (const [i, exp] of list.entries()) {
    const n = i + 1;
    console.log(C.bold(`\n━━━ ${n}/${list.length}  ${exp.id}: ${exp.title} ━━━`));
    console.log(`  ${exp.desc}`);
    const go = (await P.ask('  Enter = run, s = skip, q = quit: '))?.trim().toLowerCase();
    if (go === undefined || go === null || go === 'q') break;
    if (go === 's') {
      appendResults(`\n### ${n}. \`${exp.id}\`: skipped\n`);
      done.push({ ctx: exp.id, n, skipped: true });
      continue;
    }
    const ctx = newCtx(exp, P);
    current = { ctx, n };
    try {
      await exp.run(ctx);
    } catch (e) {
      ctx.note(`script error: ${e.message}`);
    }
    if (ctx.tokens.size) console.log(C.dim('  Cleaning up this test\'s sessions...'));
    await ctx.cleanup();
    current = null;
    appendResults(renderSection(ctx, n));
    done.push({ ctx, n });
    if (ctx.rateLimited) {
      console.log(C.yellow('  Got a 429 in this test; waiting 10 s before continuing.'));
      await sleep(10000);
    } else await sleep(1000);
  }
  cleanupHooks.pop();
  writeSummary();
  console.log(C.green(`\nDone. Results appended to ${CFG.resultsFile}`));
}

// -------------------------------------------------------------- keepalive ---

async function cmdKeepalive(f) {
  requireClientId();
  await getAccessToken();
  const noRefresh = !!f['no-refresh'];
  const intervalMs = Number(f['interval-min'] ?? 14) * 60000;
  const durationMs = f['duration-min'] !== undefined ? Number(f['duration-min']) * 60000 : Infinity;
  if (!(intervalMs > 0)) die('--interval-min must be > 0');
  const activity = activityFromFlags(f, defaultActivity({
    name: 'Keepalive test', details: noRefresh ? 'expiry test (no refresh)' : 'keepalive test', state: `started ${fmtClock(Date.now())}`,
  }));

  const startedAt = Date.now();
  const tokens = new Set();
  const T = () => `T+${fmtElapsed(Date.now() - startedAt)}`;
  appendResults(`\n## Keepalive run ${nowIso()} (${noRefresh ? 'NO refresh: expiry test' : `refresh every ${intervalMs / 60000} min`})\n\n` +
    `Activity: \`${JSON.stringify(redact(activity))}\`\n\n| time | elapsed | action | HTTP | token | notes |\n|---|---|---|---|---|---|\n`);
  const row = (action, rec, tokenNote = '', notes = '') => {
    const rl = rec ? Object.entries(rec.rateLimit).map(([k, v]) => `${k.replace('x-ratelimit-', '')}=${v}`).join(' ') : '';
    appendResults(`| ${fmtClock(Date.now())} | ${T()} | ${action} | ${rec?.status ?? ''} | ${tokenNote} | ${[notes, rl].filter(Boolean).join(' ')} |\n`);
  };

  let r = await sendSession(activity, { label: noRefresh ? 'expiry-test' : 'keepalive' });
  row('create', r.rec, r.token ? shortTok(r.token) : '', r.ok ? '' : JSON.stringify(r.rec.body).slice(0, 200));
  if (!r.ok) die('create failed; see above.');
  let token = r.token;
  tokens.add(token);
  cleanupHooks.push(async () => {
    for (const t of tokens) {
      const rec = await deleteSession(t);
      row('delete (Ctrl+C)', rec, shortTok(t));
    }
    appendResults(`\nStopped by Ctrl+C at ${T()}.\n`);
    console.log(`Logged to ${CFG.resultsFile}`);
  });

  if (noRefresh) {
    const expect = startedAt + SESSION_TTL_MS;
    console.log(C.bold(`\nCreated at ${fmtClock(startedAt)}. Documented expiry ~${fmtClock(expect)} (20 min).`));
    console.log('Nothing more is sent. Watch your profile from another account/device and press Enter the moment');
    console.log('the activity disappears (or type "q" + Enter to stop without recording).');
    const ticker = setInterval(() => console.log(C.dim(`  ${fmtClock(Date.now())}  ${T()} since create`)), 60000);
    const P = getPrompter();
    const ans = await P.ask('');
    clearInterval(ticker);
    if (ans !== null && ans.trim().toLowerCase() !== 'q') {
      const note = (await P.ask('Optional note (what you saw): ')) || '';
      row('user: activity gone', null, '', `${note.replace(/\|/g, '/')} (created ${fmtClock(startedAt)})`);
      console.log(C.green(`Recorded: gone at ${T()}.`));
      const probe = (await P.ask('Send ONE update with the old token to see what the API says now? [y/N] ')) || '';
      if (/^y/i.test(probe.trim())) {
        r = await sendSession(activity, { token });
        row('probe update with old token', r.rec, r.token ? `${shortTok(r.token)}${r.tokenChanged ? ' (changed)' : ' (same)'}` : '',
          r.ok ? 'API still accepted the token' : JSON.stringify(r.rec.body).slice(0, 200));
        if (r.token) tokens.add(r.token);
      }
    }
  } else {
    console.log(C.bold(`\nRefreshing every ${intervalMs / 60000} min with the session token. Ctrl+C to stop and delete.`));
    let n = 0;
    while (Date.now() - startedAt < durationMs) {
      const wait = Math.min(intervalMs, durationMs - (Date.now() - startedAt));
      console.log(C.dim(`  next refresh at ${fmtClock(Date.now() + wait)}`));
      await sleep(wait);
      if (Date.now() - startedAt >= durationMs) break;
      n++;
      r = await sendSession(activity, { token });
      if (r.ok) {
        row(`refresh #${n}`, r.rec, r.tokenChanged ? `CHANGED → ${shortTok(r.token)}` : 'same');
        tokens.add(r.token);
        token = r.token;
      } else if ([400, 404].includes(r.rec.status)) {
        row(`refresh #${n}`, r.rec, '', `session gone: ${JSON.stringify(r.rec.body).slice(0, 150)}; recreating`);
        tokens.delete(token);
        forgetSession(token);
        r = await sendSession(activity, { label: 'keepalive' });
        row('recreate', r.rec, r.token ? shortTok(r.token) : '');
        if (r.ok) {
          token = r.token;
          tokens.add(token);
        }
      } else if (r.rec.status === 429) {
        const ra = Number(r.rec.body?.retry_after || 5);
        row(`refresh #${n}`, r.rec, '', `rate limited, retry_after=${ra}`);
        await sleep(ra * 1000);
      } else {
        row(`refresh #${n}`, r.rec, '', `unexpected: ${JSON.stringify(r.rec.body ?? r.rec.error).slice(0, 150)}`);
      }
    }
  }
  cleanupHooks.pop();
  for (const t of tokens) {
    const rec = await deleteSession(t);
    row('delete', rec, shortTok(t));
  }
  appendResults(`\nFinished at ${T()}.\n`);
  console.log(`Logged to ${CFG.resultsFile}`);
}

// ------------------------------------------------------------ self tests ---

function cmdPkceSelftest() {
  const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const got = pkceChallenge(v);
  console.log(`RFC 7636 appendix B: ${got === expected ? C.green('PASS') : C.red(`FAIL (got ${got})`)}`);
  const { verifier, challenge } = makePkce();
  const vOk = /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
  console.log(`random verifier: ${verifier.length} chars, charset ok: ${vOk ? C.green('yes') : C.red('no')}`);
  console.log(`challenge matches verifier: ${pkceChallenge(verifier) === challenge ? C.green('yes') : C.red('no')}`);
  const url = new URL(buildAuthorizeUrl({ clientId: CFG.clientId || '123456789012345678', redirectUri: CFG.redirectUri, state: 'STATE', challenge }));
  console.log(`sample authorize URL:\n  ${url}`);
  for (const [k, v2] of url.searchParams) console.log(`    ${k} = ${v2}`);
  const parsed = parseCallbackInput(`${CFG.redirectUri}?code=abc123&state=xyz`);
  const bare = parseCallbackInput('  abc123 ');
  const pass = got === expected && vOk && parsed.code === 'abc123' && parsed.state === 'xyz' && bare.code === 'abc123';
  console.log(`callback parsing (full URL + bare code): ${parsed.code === 'abc123' && bare.code === 'abc123' ? C.green('ok') : C.red('bad')}`);
  process.exitCode = pass ? 0 : 1;
}

function cmdAuthUrl() {
  requireClientId();
  const { challenge } = makePkce();
  console.log(buildAuthorizeUrl({ clientId: CFG.clientId, redirectUri: CFG.redirectUri, state: b64url(crypto.randomBytes(24)), challenge }));
  console.log(C.dim('(verifier discarded: use "login" to actually log in)'));
}

// ------------------------------------------------------------------ main ---

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  'show-secrets': { type: 'boolean' },
  'no-server': { type: 'boolean' },
  code: { type: 'string' },
  type: { type: 'string' }, name: { type: 'string' }, details: { type: 'string' }, state: { type: 'string' },
  'large-image': { type: 'string' }, 'large-text': { type: 'string' },
  'small-image': { type: 'string' }, 'small-text': { type: 'string' },
  start: { type: 'string' }, end: { type: 'string' },
  button: { type: 'string', multiple: true }, 'button-format': { type: 'string' },
  'status-display-type': { type: 'string' }, 'app-id': { type: 'string' }, platform: { type: 'string' },
  'no-supported-platforms': { type: 'boolean' }, extra: { type: 'string' },
  session: { type: 'string' }, label: { type: 'string' },
  only: { type: 'string' }, skip: { type: 'string' }, list: { type: 'boolean' }, image: { type: 'string' },
  'burst-count': { type: 'string' }, 'burst-interval': { type: 'string' },
  'no-refresh': { type: 'boolean' }, 'interval-min': { type: 'string' }, 'duration-min': { type: 'string' },
};

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    die(`${e.message}\nRun with --help for usage.`);
  }
  const f = parsed.values;
  const cmd = parsed.positionals[0];
  CFG.showSecrets = !!f['show-secrets'];
  if (f['button-format'] && !['labels', 'objects'].includes(f['button-format'])) die('--button-format must be labels or objects');
  if (f.button?.length > 2) console.warn(C.yellow('Warning: docs say max 2 buttons.'));
  if (f.help || !cmd || cmd === 'help') {
    console.log(HELP);
    return;
  }
  const commands = {
    login: () => cmdLogin(f),
    'auth-url': cmdAuthUrl,
    'pkce-selftest': cmdPkceSelftest,
    whoami: () => cmdWhoami(),
    'refresh-token': refreshAccessToken,
    create: () => cmdCreate(f),
    update: () => cmdUpdate(f),
    delete: () => cmdDelete(f),
    'delete-all': cmdDeleteAll,
    sessions: cmdSessions,
    experiments: () => cmdExperiments(f),
    keepalive: () => cmdKeepalive(f),
  };
  if (!commands[cmd]) die(`unknown command "${cmd}". Run with --help.`);
  await commands[cmd]();
}

main()
  .catch((e) => {
    console.error(C.red(e.stack || e.message));
    process.exitCode = 1;
  })
  .finally(() => {
    prompter?.close();
    // Exit explicitly so a lingering stdin/readline or server handle can't keep us alive.
    setImmediate(() => process.exit(process.exitCode ?? 0));
  });
