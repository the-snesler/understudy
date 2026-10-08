import crypto from 'node:crypto';

/**
 * Discord OAuth2 authorization code flow with PKCE, for an app with "Public Client" enabled and the
 * Social SDK turned on (without it Discord answers `invalid_scope`).
 */

export const SCOPES = ['openid', 'sdk.social_layer_presence'] as const;

export interface TokenSet {
  accessToken: string;
  refreshToken: string | undefined;
  scope: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface OAuthEndpoints {
  /** Browser-facing authorize page. */
  authorizeUrl: string;
  /** API base, e.g. https://discord.com/api/v10 */
  apiBase: string;
}

export const DEFAULT_ENDPOINTS: OAuthEndpoints = {
  authorizeUrl: process.env.DISCORD_AUTHORIZE_URL || 'https://discord.com/oauth2/authorize',
  apiBase: process.env.DISCORD_API_BASE || 'https://discord.com/api/v10',
};

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthorizeUrl(opts: {
  endpoints: OAuthEndpoints;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(opts.endpoints.authorizeUrl);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/** Accepts a full redirected URL (`...?code=...&state=...`) or a bare code. */
export function parseCallbackInput(input: string): { code?: string; state?: string; error?: string } {
  const text = input.trim();
  if (!text) return {};
  if (/^[\w-]+$/.test(text)) return { code: text };
  try {
    const url = new URL(text);
    const p = url.searchParams;
    const error = p.get('error');
    if (error) return { error: [error, p.get('error_description')].filter(Boolean).join(': ') };
    return { code: p.get('code') ?? undefined, state: p.get('state') ?? undefined };
  } catch {
    return {};
  }
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

async function tokenRequest(
  endpoints: OAuthEndpoints,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const res = await fetchImpl(`${endpoints.apiBase}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = [body.error, body.error_description].filter(Boolean).join(': ') || res.statusText;
    throw new OAuthError(`Discord token request failed (${res.status}): ${detail}`, res.status, body);
  }
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : undefined,
    scope: String(body.scope ?? ''),
    expiresAt: Date.now() + Number(body.expires_in ?? 0) * 1000,
  };
}

export function exchangeCode(opts: {
  endpoints: OAuthEndpoints;
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenSet> {
  return tokenRequest(
    opts.endpoints,
    {
      client_id: opts.clientId,
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
    },
    opts.fetchImpl ?? fetch,
  );
}

export async function refreshTokens(opts: {
  endpoints: OAuthEndpoints;
  clientId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenSet> {
  const next = await tokenRequest(
    opts.endpoints,
    { client_id: opts.clientId, grant_type: 'refresh_token', refresh_token: opts.refreshToken },
    opts.fetchImpl ?? fetch,
  );
  // Discord normally rotates the refresh token; keep the old one if it doesn't.
  return { ...next, refreshToken: next.refreshToken ?? opts.refreshToken };
}

export async function revokeToken(opts: {
  endpoints: OAuthEndpoints;
  clientId: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  await (opts.fetchImpl ?? fetch)(`${opts.endpoints.apiBase}/oauth2/token/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: opts.clientId, token: opts.token }),
  });
}
