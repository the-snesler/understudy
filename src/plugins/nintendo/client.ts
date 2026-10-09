import fs from 'node:fs';
import path from 'node:path';
import type { CoralAuthData, Friend_4 } from 'nxapi/coral';

/**
 * Access to the Nintendo Switch Online app's API (Coral) through nxapi, behind a small interface so
 * the plugin can be tested without Nintendo.
 *
 * nxapi is imported lazily: importing it contacts nxapi's config server, and logging in sends
 * tokens to the third-party f-token API (nxapi-znca-api). Both must wait for the user's consent.
 */

export interface PendingLogin {
  url: string;
  state: string;
  verifier: string;
  createdAt: number;
}

export interface FriendGame {
  name: string;
  imageUri: string;
  shopUri: string;
  /** Minutes. */
  totalPlayTime: number;
  sysDescription: string;
}

export interface FriendInfo {
  nsaId: string;
  name: string;
  imageUri: string;
  presence: {
    state: string; // OFFLINE | INACTIVE | ONLINE | PLAYING
    /** Seconds. Changes roughly hourly while a console is online, even without a presence change. */
    updatedAt: number;
    /** 1 = Nintendo Switch, 2 = Nintendo Switch 2 (v4 friend list). */
    platform?: number;
    game?: FriendGame;
  };
}

export interface LoginResult {
  sessionToken: string;
  auth: CoralAuthData;
  /** The Nintendo Switch Online account name of the account that signed in. */
  accountName: string;
}

export interface CoralConnection {
  friends(): Promise<FriendInfo[]>;
}

export interface NintendoBackend {
  beginLogin(): Promise<PendingLogin>;
  /** `link` is the `npf71b963c1b7b6d119://auth#...` URL from "Select this person". */
  completeLogin(pending: PendingLogin, link: string): Promise<LoginResult>;
  /**
   * Connect with saved auth data. When Nintendo reports the token expired, it is renewed with the
   * session token (as the official app does) and `onAuthUpdate` is called with the new data.
   */
  connect(sessionToken: string, auth: CoralAuthData, onAuthUpdate: (auth: CoralAuthData) => void): CoralConnection;
}

export interface BackendOptions {
  /** nxapi-auth client identifier for the f-token API. */
  clientId: string;
  /** e.g. `understudy/0.1.0 (+https://...)` */
  userAgent: string;
  /** Where nxapi may keep its cache. */
  dataDir?: string;
}

export class NintendoAuthError extends Error {
  /** True when the session token is no longer valid and the user must sign in again. */
  constructor(
    message: string,
    readonly signInAgain: boolean,
  ) {
    super(message);
  }
}

type Nxapi = typeof import('nxapi') & { coral: typeof import('nxapi/coral') };
let loaded: Promise<Nxapi> | undefined;

async function loadNxapi(opts: BackendOptions): Promise<Nxapi> {
  loaded ??= (async () => {
    if (opts.dataDir) {
      // nxapi caches its remote config under the XDG directories (env-paths); keep it with our data.
      const base = path.join(opts.dataDir, 'nxapi');
      fs.mkdirSync(base, { recursive: true });
      process.env.XDG_CACHE_HOME ??= path.join(base, 'cache');
      process.env.XDG_DATA_HOME ??= path.join(base, 'data');
      process.env.XDG_CONFIG_HOME ??= path.join(base, 'config');
    }
    const root = await import('nxapi');
    const coral = await import('nxapi/coral');
    root.addUserAgent(opts.userAgent);
    return { ...root, coral };
  })();
  const nxapi = await loaded;
  // Global in nxapi; set on every use so a changed client id applies without a restart.
  nxapi.setClientAuthentication({ id: opts.clientId, scope: 'ca:gf ca:er ca:dr' });
  return nxapi;
}

/** Parse the pasted "Select this person" link into its fragment parameters. */
export function parseAppLink(link: string): URLSearchParams {
  const text = link.trim();
  const hash = text.indexOf('#');
  if (!text.startsWith('npf71b963c1b7b6d119://auth') || hash === -1) {
    throw new Error('Paste the link from "Select this person": it starts with npf71b963c1b7b6d119://auth#');
  }
  return new URLSearchParams(text.slice(hash + 1));
}

function describeError(err: unknown): NintendoAuthError | Error {
  const e = err as { data?: { error?: string; error_description?: string; errorMessage?: string; status?: number }; message?: string };
  if (e?.data?.error === 'invalid_grant') {
    return new NintendoAuthError('Nintendo no longer accepts this sign-in; sign in again.', true);
  }
  if (e?.data?.error) return new Error(`Nintendo Account error: ${e.data.error_description ?? e.data.error}`);
  return err instanceof Error ? err : new Error(String(err));
}

export class NxapiBackend implements NintendoBackend {
  constructor(private readonly opts: BackendOptions) {}

  async beginLogin(): Promise<PendingLogin> {
    const { coral } = await loadNxapi(this.opts);
    const auth = coral.NintendoAccountSessionAuthorisationCoral.create();
    return { url: auth.authorise_url, state: auth.state, verifier: auth.verifier, createdAt: Date.now() };
  }

  async completeLogin(pending: PendingLogin, link: string): Promise<LoginResult> {
    const params = parseAppLink(link);
    const { coral } = await loadNxapi(this.opts);
    const auth = coral.NintendoAccountSessionAuthorisationCoral.resume(pending.url, pending.state, pending.verifier);
    try {
      const token = await auth.getSessionToken(params);
      const { nso, data } = await coral.default.createWithSessionToken(token.session_token);
      // Do what the app does after signing in.
      await Promise.all([nso.getAnnouncements(), nso.getFriendList(), nso.getWebServices(), nso.getActiveEvent()]);
      return { sessionToken: token.session_token, auth: data, accountName: data.nsoAccount.user.name };
    } catch (err) {
      throw describeError(err);
    }
  }

  connect(sessionToken: string, auth: CoralAuthData, onAuthUpdate: (auth: CoralAuthData) => void): CoralConnection {
    let api: import('nxapi/coral').default | undefined;
    let current = auth;
    const get = async () => {
      if (api) return api;
      const { coral } = await loadNxapi(this.opts);
      api = coral.default.createWithSavedToken(current);
      api.onTokenExpired = async () => {
        try {
          const renewed = await api!.getToken(sessionToken, current.user);
          current = { ...current, ...renewed };
          onAuthUpdate(current);
          return current;
        } catch (err) {
          throw describeError(err);
        }
      };
      return api;
    };
    return {
      async friends() {
        try {
          const list = await (await get()).getFriendList();
          return list.friends.map(toFriendInfo);
        } catch (err) {
          throw describeError(err);
        }
      },
    };
  }
}

function toFriendInfo(f: Friend_4): FriendInfo {
  const game = f.presence.game as Partial<FriendGame>;
  return {
    nsaId: f.nsaId,
    name: f.name,
    imageUri: f.imageUri,
    presence: {
      state: f.presence.state,
      updatedAt: f.presence.updatedAt,
      platform: 'platform' in f.presence ? f.presence.platform : undefined,
      game: game?.name
        ? {
            name: game.name,
            imageUri: game.imageUri ?? '',
            shopUri: game.shopUri ?? '',
            totalPlayTime: game.totalPlayTime ?? 0,
            sysDescription: game.sysDescription ?? '',
          }
        : undefined,
    },
  };
}

/** Our User-Agent component, from package.json: `name/version (+homepage)`. */
export function userAgent(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      name?: string;
      version?: string;
      homepage?: string;
    };
    return `${pkg.name ?? 'understudy'}/${pkg.version ?? '0.0.0'}${pkg.homepage ? ` (+${pkg.homepage})` : ''}`;
  } catch {
    return 'understudy/0.0.0';
  }
}
