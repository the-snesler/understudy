import type { Hono } from 'hono';
import type { Registry } from '../core/registry.js';

/** Feed paths from before feeds were outputs, and the output plugin that now serves each one. */
const LEGACY_FEEDS = [
  { path: '/feed/history.ics', plugin: 'calendar-feed', file: 'calendar.ics' },
  { path: '/api/history.json', plugin: 'json-feed', file: 'history.json' },
] as const;

/**
 * Old links keep working once the matching feed output is added and enabled: they're answered by
 * whichever running instance accepts the token (the first instance adopts the old token). Register
 * before UI authentication; feeds authenticate with their own token.
 */
export function registerLegacyFeedRoutes(app: Hono, registry: Registry): void {
  for (const feed of LEGACY_FEEDS) {
    app.get(feed.path, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      c.header('Referrer-Policy', 'no-referrer');
      const running = registry.list().filter((view) => view.config.plugin === feed.plugin && view.live);
      if (!running.length) return c.json({ error: 'This feed is off. Add and enable its output in Understudy.' }, 404);
      const url = new URL(c.req.url);
      let last: Response | undefined;
      for (const view of running) {
        last = await view.live!.publicApp.request(`/public/${view.config.id}/${feed.file}${url.search}`);
        if (last.status !== 401) return last;
      }
      return last!;
    });
  }
}
