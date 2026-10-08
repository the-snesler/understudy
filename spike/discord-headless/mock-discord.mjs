#!/usr/bin/env node
// Tiny fake of the Discord endpoints headless-test.mjs uses, for offline testing only.
// Its behaviour is GUESSED (we don't know the real API's exact responses).
//
//   node mock-discord.mjs            # listens on 127.0.0.1:8799
//   DISCORD_API_BASE=http://127.0.0.1:8799/api/v10 \
//   DISCORD_AUTHORIZE_URL=http://127.0.0.1:8799/oauth2/authorize \
//   DISCORD_CLIENT_ID=111111111111111111 node headless-test.mjs login
//
// Env: MOCK_PORT (8799), MOCK_EXPIRES_IN (access token seconds, 604800),
//      MOCK_RL_LIMIT (5 requests) / MOCK_RL_WINDOW_MS (10000) for headless-session calls,
//      MOCK_SESSION_TTL_MS (1200000), MOCK_REJECT_OBJECT_BUTTONS (1 = 400 on [{label,url}] buttons)

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 8799);
const EXPIRES_IN = Number(process.env.MOCK_EXPIRES_IN || 604800);
const RL_LIMIT = Number(process.env.MOCK_RL_LIMIT || 5);
const RL_WINDOW = Number(process.env.MOCK_RL_WINDOW_MS || 10000);
const TTL = Number(process.env.MOCK_SESSION_TTL_MS || 20 * 60 * 1000);
const REJECT_OBJECT_BUTTONS = process.env.MOCK_REJECT_OBJECT_BUTTONS !== '0';

const codes = new Map(); // code -> {challenge, client_id, redirect_uri, scope}
const access = new Map(); // access token -> {client_id, scope, expires}
const refresh = new Map(); // refresh token -> {client_id, scope}
const sessions = new Map(); // session token -> {activity, expires}
let hits = [];

const rnd = (n = 24) => crypto.randomBytes(n).toString('base64url');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function send(res, status, body, headers = {}) {
  const h = { ...headers };
  let payload = '';
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  res.writeHead(status, h).end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
}

function issue(client_id, scope) {
  const at = `mock_at_${rnd()}`;
  const rt = `mock_rt_${rnd()}`;
  access.set(at, { client_id, scope, expires: Date.now() + EXPIRES_IN * 1000 });
  refresh.set(rt, { client_id, scope });
  return { token_type: 'Bearer', access_token: at, expires_in: EXPIRES_IN, refresh_token: rt, scope };
}

function rateLimit(res) {
  const now = Date.now();
  hits = hits.filter((t) => now - t < RL_WINDOW);
  const resetAfter = hits.length ? (RL_WINDOW - (now - hits[0])) / 1000 : RL_WINDOW / 1000;
  const headers = {
    'X-RateLimit-Limit': String(RL_LIMIT),
    'X-RateLimit-Remaining': String(Math.max(0, RL_LIMIT - hits.length - 1)),
    'X-RateLimit-Reset': String((now / 1000 + resetAfter).toFixed(3)),
    'X-RateLimit-Reset-After': resetAfter.toFixed(3),
    'X-RateLimit-Bucket': 'mockbucket123',
  };
  if (hits.length >= RL_LIMIT) {
    send(res, 429, { message: 'You are being rate limited.', retry_after: Number(resetAfter.toFixed(3)), global: false },
      { ...headers, 'Retry-After': String(Math.ceil(resetAfter)), 'X-RateLimit-Scope': 'user' });
    return null;
  }
  hits.push(now);
  return headers;
}

function validateActivity(a) {
  const errors = {};
  if (typeof a?.name !== 'string' || a.name.length < 1 || a.name.length > 128) errors.name = 'required, 1-128 chars';
  if (!Number.isInteger(a?.type) || a.type < 0 || a.type > 6) errors.type = 'required int 0-6';
  if (!/^\d{15,22}$/.test(String(a?.application_id || ''))) errors.application_id = 'required snowflake';
  if (!a?.platform) errors.platform = 'required';
  if (a?.status_display_type !== undefined && ![0, 1, 2].includes(a.status_display_type)) errors.status_display_type = 'invalid';
  if (Array.isArray(a?.buttons) && a.buttons.some((b) => typeof b !== 'string') && REJECT_OBJECT_BUTTONS) {
    errors.buttons = 'must be array of strings (mock assumption)';
  }
  return Object.keys(errors).length ? errors : null;
}

function proxyAssets(a) {
  const out = structuredClone(a);
  for (const k of ['large_image', 'small_image']) {
    const v = out.assets?.[k];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) out.assets[k] = `mp:external/${rnd(8)}/${v.replace('://', '/')}`;
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const raw = await readBody(req);
  log(req.method, p);

  // Browser step: "approve" immediately and redirect back with a code.
  if (req.method === 'GET' && p === '/oauth2/authorize') {
    const q = url.searchParams;
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return send(res, 400, { error: 'invalid_request' });
    const code = `mock_code_${rnd(12)}`;
    codes.set(code, { challenge: q.get('code_challenge'), client_id: q.get('client_id'), redirect_uri: q.get('redirect_uri'), scope: q.get('scope') });
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { Location: back.toString() }).end();
    return;
  }

  if (req.method === 'POST' && (p === '/api/v10/oauth2/token' || p === '/api/oauth2/token')) {
    const f = new URLSearchParams(raw);
    if (f.get('grant_type') === 'authorization_code') {
      const c = codes.get(f.get('code'));
      if (!c) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid "code" in request.' });
      codes.delete(f.get('code'));
      const challenge = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
      if (challenge !== c.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      if (f.get('client_id') !== c.client_id || f.get('redirect_uri') !== c.redirect_uri) {
        return send(res, 400, { error: 'invalid_grant', error_description: 'client_id/redirect_uri mismatch' });
      }
      const scope = c.scope.split(' ').includes('sdk.social_layer_presence')
        ? `${c.scope} activities.write` : c.scope; // guess: umbrella expands
      return send(res, 200, issue(c.client_id, scope));
    }
    if (f.get('grant_type') === 'refresh_token') {
      const r = refresh.get(f.get('refresh_token'));
      if (!r) return send(res, 400, { error: 'invalid_grant' });
      refresh.delete(f.get('refresh_token'));
      return send(res, 200, issue(r.client_id, r.scope));
    }
    return send(res, 400, { error: 'unsupported_grant_type' });
  }

  const at = (req.headers.authorization || '').replace(/^Bearer /, '');
  const auth = access.get(at);
  if (!auth || auth.expires < Date.now()) return send(res, 401, { message: '401: Unauthorized', code: 0 });

  if (req.method === 'GET' && p === '/api/v10/oauth2/@me') {
    return send(res, 200, {
      application: { id: auth.client_id, name: 'Mock App' }, scopes: auth.scope.split(' '),
      expires: new Date(auth.expires).toISOString(), user: { id: '222222222222222222', username: 'mockuser' },
    });
  }
  if (req.method === 'GET' && p === '/api/v10/users/@me') return send(res, 200, { id: '222222222222222222', username: 'mockuser' });

  if (req.method === 'POST' && p.startsWith('/api/v10/users/@me/headless-sessions')) {
    if (!auth.scope.split(' ').includes('activities.write')) return send(res, 403, { message: 'Missing Access', code: 50001 });
    const headers = rateLimit(res);
    if (!headers) return;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { message: '400: Bad Request', code: 0 }, headers);
    }
    for (const [t, s] of sessions) if (s.expires < Date.now()) sessions.delete(t);

    if (p === '/api/v10/users/@me/headless-sessions/delete') {
      if (!sessions.delete(body.token)) return send(res, 404, { message: 'Unknown Session', code: 10020 }, headers);
      return send(res, 204, undefined, headers);
    }
    if (p !== '/api/v10/users/@me/headless-sessions') return send(res, 404, { message: '404: Not Found', code: 0 });
    if (!Array.isArray(body.activities) || body.activities.length !== 1) {
      return send(res, 400, { message: 'Invalid Form Body', code: 50035, errors: { activities: 'exactly one' } }, headers);
    }
    const errs = validateActivity(body.activities[0]);
    if (errs) return send(res, 400, { message: 'Invalid Form Body', code: 50035, errors: errs }, headers);
    let token = body.token;
    if (token && !sessions.has(token)) return send(res, 404, { message: 'Unknown Session', code: 10020 }, headers);
    token ||= `mock_hs_${rnd(32)}`;
    const activity = proxyAssets(body.activities[0]);
    sessions.set(token, { activity, expires: Date.now() + TTL });
    log(`  sessions live: ${sessions.size}`);
    return send(res, 200, { activities: [activity], token }, headers);
  }
  send(res, 404, { message: '404: Not Found', code: 0 });
});

server.listen(PORT, '127.0.0.1', () => log(`mock Discord on http://127.0.0.1:${PORT}`));
