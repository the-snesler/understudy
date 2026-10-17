import type { Hono } from 'hono';
import { z } from 'zod';
import type { HistorySegment } from '../../core/history.js';
import { defineOutput, type OutputContext, type PanelProps } from '../../core/plugin.js';
import { createFeedAccess, FeedLinkCard, parseHistoryQuery } from './shared.js';

const configSchema = z.object({
  includeDisplayed: z.boolean().default(true).meta({
    title: 'Include what outputs showed', group: 'What to publish',
    description: 'Adds `outputSegments`: when each output showed which activity. Sources’ own segments are always included.',
  }),
});

type Config = z.infer<typeof configSchema>;

function createJsonFeed(ctx: OutputContext<Config>) {
  const access = createFeedAccess(ctx, 'json-feed', { file: 'history.json' });
  const labelled = (items: HistorySegment[]) => items.map((item) => ({ ...item, sourceLabel: ctx.history!.label(item.sourceId) }));
  return {
    start() {},
    stop() {},
    onState() {},
    status: () => access.status(),
    routes: (app: Hono) => access.routes(app),
    publicRoutes(app: Hono) {
      app.get('/history.json', (c) => {
        const denied = access.guard(c);
        if (denied) return denied;
        let query;
        try {
          query = parseHistoryQuery(c.req.query());
        } catch (error) {
          return c.json({ error: (error as Error).message }, 400);
        }
        const history = ctx.history!;
        return c.json({
          generatedAt: Date.now(),
          timeZone: history.timeZone(),
          segments: labelled(history.query({ ...query, scope: 'source' })),
          ...(ctx.config.includeDisplayed ? { outputSegments: labelled(history.query({ ...query, scope: 'output' })) } : {}),
        });
      });
    },
    panel(props: PanelProps) {
      return (
        <FeedLinkCard
          access={access}
          props={props}
          title="JSON link"
          description="For scripts, bots and dashboards. Add from and to (ISO dates or epoch milliseconds) or sourceId to narrow it."
          routeBase={ctx.routeBase}
        />
      );
    },
  };
}

export const jsonFeedPlugin = defineOutput({
  id: 'json-feed',
  name: 'JSON feed',
  description: 'Publishes your history as JSON at a secret link, for scripts, bots and dashboards.',
  publishes: 'history',
  multiple: true,
  configSchema,
  create: createJsonFeed,
});
