import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { errorMessage } from '../../core/log.js';
import type { HistoryQuery } from '../../core/history.js';
import type { InstanceStatus, OutputContext, PanelProps } from '../../core/plugin.js';
import { Icon } from '../../web/icons.js';
import { timeAgo } from '../../web/layout.js';

interface FeedState {
  token?: string;
  lastReadAt?: number;
}

export interface FeedLink {
  /** File name under the instance's public base, e.g. `calendar.ics`. */
  file: string;
}

/**
 * A feed output publishes history at a secret link under `/public/<instance>/`. Each feed has its
 * own token; the first instance of each feed plugin adopts the app-wide token from before feeds
 * were outputs, so existing subscriptions keep working once the output is added.
 */
export function createFeedAccess(ctx: OutputContext<unknown>, pluginId: string, link: FeedLink) {
  const read = (): FeedState => (ctx.state.get() ?? {}) as FeedState;
  const save = (patch: Partial<FeedState>) => {
    ctx.state.set({ ...read(), ...patch }).catch((err: unknown) => ctx.log.error(`Could not save state: ${errorMessage(err)}`));
  };
  let token = read().token;
  if (!token) {
    token = (ctx.instanceId === pluginId ? ctx.history?.legacyFeedToken() : undefined) ?? randomBytes(32).toString('base64url');
    save({ token });
  }
  const hash = (value: string) => createHash('sha256').update(value).digest();

  const access = {
    valid(candidate: string | undefined): boolean {
      return !!candidate && timingSafeEqual(hash(candidate), hash(token!));
    },
    url(origin: string): string {
      return `${origin.replace(/\/+$/, '')}${ctx.publicBase}/${link.file}?token=${encodeURIComponent(token!)}`;
    },
    lastReadAt: () => read().lastReadAt,
    /** Check the token and record the read; returns an error response when it fails. */
    guard(c: Context): Response | undefined {
      c.header('Cache-Control', 'private, no-store');
      c.header('Referrer-Policy', 'no-referrer');
      if (!ctx.history) return c.json({ error: 'History storage is not available' }, 503);
      if (!access.valid(c.req.query('token'))) return c.json({ error: 'Unauthorized' }, 401);
      save({ lastReadAt: Date.now() });
      ctx.reportSuccess?.();
      return undefined;
    },
    status(): InstanceStatus {
      if (!ctx.history) return { health: 'error', message: 'History storage is not available' };
      const at = read().lastReadAt;
      return { health: 'ok', message: at ? `Link ready · read ${timeAgo(at)}` : 'Link ready · not read yet', lastSuccessAt: at };
    },
    routes(app: Hono): void {
      app.post('/regenerate', (c) => {
        token = randomBytes(32).toString('base64url');
        save({ token, lastReadAt: undefined });
        ctx.log.info('Created a new feed link; the previous one no longer works');
        const notice = 'New link created. The previous link no longer works; update anything that used it.';
        return c.redirect(`/instances/${ctx.instanceId}?message=${encodeURIComponent(notice)}`);
      });
    },
  };
  return access;
}

export type FeedAccess = ReturnType<typeof createFeedAccess>;

/** The link, how to use it, and how to revoke it. */
export function FeedLinkCard({
  access,
  props,
  title,
  description,
  routeBase,
  subscribe,
}: {
  access: FeedAccess;
  props: PanelProps;
  title: string;
  description: string;
  routeBase: string;
  /** e.g. a `webcal://` link that opens the calendar app. */
  subscribe?: { label: string; href: string };
}) {
  const url = access.url(props.origin);
  const readAt = access.lastReadAt();
  return (
    <section class="card flush">
      <div class="card-header">
        <div><h2>{title}</h2><p class="muted small">{description}</p></div>
      </div>
      <div class="card-body">
        <div class="copy-row feed-link">
          <code>{url}</code>
          <button type="button" class="btn" data-copy={url} aria-label={`Copy the ${title.toLowerCase()}`}>
            <Icon name="copy" size={14} />Copy
          </button>
        </div>
        <p class="help">
          {readAt ? `Last read ${timeAgo(readAt)}.` : 'Not read yet.'} Anyone with this link can read
          what it publishes; treat it like a password.
        </p>
        <div class="actions mt-4">
          {subscribe && <a class="btn" href={subscribe.href}><Icon name="calendar" size={15} />{subscribe.label}</a>}
          <form method="post" action={`${routeBase}/regenerate`}>
            <button class="btn"><Icon name="restart" size={15} />Create a new link</button>
          </form>
        </div>
      </div>
    </section>
  );
}

/** Optional `from`/`to` (ISO dates or epoch milliseconds) and `sourceId` query parameters. */
export function parseHistoryQuery(query: Record<string, string>): HistoryQuery {
  const parseTime = (name: string): number | undefined => {
    const value = query[name];
    if (value === undefined) return undefined;
    const at = /^-?\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (!Number.isSafeInteger(at)) throw new Error(`${name} must be an ISO date or epoch milliseconds.`);
    return at;
  };
  const from = parseTime('from');
  const to = parseTime('to');
  if (from !== undefined && to !== undefined && from >= to) throw new Error('from must be earlier than to.');
  return { from, to, sourceId: query.sourceId };
}
