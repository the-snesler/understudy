import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set when the request carries a valid session, so the layout can offer "Log out". */
    signedIn?: boolean;
  }
}

export const SESSION_COOKIE = 'understudy_session';
/** How long a sign-in lasts. Sessions are renewed once less than half of this is left. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export function newSessionSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The single UI password and the sessions it grants. A session is a signed expiry time, so nothing is
 * stored per session. The signing key depends on the password: changing it signs everyone out.
 */
export class Auth {
  private readonly passwordHash: Buffer;
  private readonly key: Buffer;
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(password: string, secret: string) {
    this.passwordHash = sha256(password);
    this.key = createHmac('sha256', secret).update(`session:${password}`).digest();
  }

  checkPassword(candidate: string): boolean {
    return timingSafeEqual(sha256(candidate), this.passwordHash);
  }

  /** A session token valid until `now + SESSION_TTL_MS`. */
  issue(now = Date.now()): string {
    const expires = String(now + SESSION_TTL_MS);
    return `${expires}.${this.sign(expires)}`;
  }

  /** The token's expiry (epoch ms) if it's genuine and unexpired. */
  verify(token: string | undefined, now = Date.now()): number | undefined {
    const [expires, sig, extra] = (token ?? '').split('.');
    if (!expires || !sig || extra !== undefined || !/^\d+$/.test(expires)) return undefined;
    const expected = Buffer.from(this.sign(expires));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    const at = Number(expires);
    return at > now ? at : undefined;
  }

  /** Milliseconds `client` must wait before trying another password, or 0. */
  lockedFor(client: string, now = Date.now()): number {
    const f = this.failures.get(client);
    if (!f || f.resetAt <= now) return 0;
    return f.count >= MAX_FAILURES ? f.resetAt - now : 0;
  }

  recordFailure(client: string, now = Date.now()): void {
    for (const [k, f] of this.failures) if (f.resetAt <= now) this.failures.delete(k);
    const f = this.failures.get(client);
    if (f) f.count++;
    else this.failures.set(client, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  }

  private sign(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }
}
