import type { Hono } from 'hono';
import { z } from 'zod';
import type { ActivityKind, NowPlaying } from '../../core/activity.js';
import { describeActivity } from '../../core/activity.js';
import { defineSource, type SourceContext } from '../../core/plugin.js';

/**
 * A source you drive from the web UI. It's for trying out outputs without a real service, and for
 * showing a one-off activity by hand.
 */

const configSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .default('Manual')
    .meta({ title: 'Default activity name', description: 'Pre-filled "name" for new activities.' }),
});

type Config = z.infer<typeof configSchema>;

const formSchema = z.object({
  kind: z.enum(['playing', 'watching', 'listening']),
  name: z.string().trim().min(1),
  title: z.string().trim().min(1),
  subtitle: z.string().trim(),
  largeImage: z.string().trim(),
  smallImage: z.string().trim(),
  minutes: z.coerce.number().min(0).max(24 * 60),
  elapsed: z.coerce.number().min(0).max(24 * 60),
  paused: z.boolean(),
  linkLabel: z.string().trim(),
  linkUrl: z.string().trim(),
});

function createManual(ctx: SourceContext<Config>) {
  const saved = () => ctx.state.get()?.activity as NowPlaying | undefined;

  return {
    start() {
      ctx.publish(saved() ?? null);
    },
    stop() {},
    status() {
      return saved()
        ? { health: 'ok' as const, message: 'Activity set' }
        : { health: 'idle' as const, message: 'Nothing set' };
    },

    routes(app: Hono) {
      const back = `/instances/${ctx.instanceId}`;
      app.post('/set', async (c) => {
        const form = await c.req.parseBody();
        const parsed = formSchema.safeParse({ ...form, paused: form.paused === 'on' });
        if (!parsed.success) {
          return c.redirect(`${back}?error=${encodeURIComponent(parsed.error.issues.map((i) => `${i.path}: ${i.message}`).join('; '))}`);
        }
        const f = parsed.data;
        const now = Date.now();
        const activity: NowPlaying = {
          key: `manual:${now}`,
          kind: f.kind as ActivityKind,
          name: f.name,
          title: f.title,
          ...(f.subtitle && { subtitle: f.subtitle }),
          ...(f.largeImage && { largeImage: { url: f.largeImage, text: f.title } }),
          ...(f.smallImage && { smallImage: { url: f.smallImage, text: f.name } }),
          ...(f.minutes > 0 || f.elapsed > 0 ? { startedAt: now - f.elapsed * 60_000 } : {}),
          ...(f.minutes > 0 && { endsAt: now + (f.minutes - f.elapsed) * 60_000 }),
          ...(f.paused && { paused: true }),
          ...(f.linkLabel && f.linkUrl && { links: [{ label: f.linkLabel, url: f.linkUrl }] }),
        };
        await ctx.state.set({ activity });
        ctx.publish(activity);
        ctx.log.info(`Set: ${describeActivity(activity)}`);
        return c.redirect(`${back}?notice=set`);
      });

      app.post('/clear', async (c) => {
        await ctx.state.set({});
        ctx.publish(null);
        ctx.log.info('Cleared');
        return c.redirect(`${back}?notice=cleared`);
      });
    },

    panel() {
      const a = saved();
      return (
        <div class="card">
          <h2>Set an activity</h2>
          <form method="post" action={`${ctx.routeBase}/set`}>
            <label>
              Type
              <select name="kind">
                {(['watching', 'listening', 'playing'] as const).map((k) => (
                  <option value={k} selected={(a?.kind ?? 'watching') === k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name
              <div class="help">Shown as "Watching &lt;name&gt;".</div>
              <input type="text" name="name" value={a?.name ?? ctx.config.name} required />
            </label>
            <label>
              Title (details line)
              <input type="text" name="title" value={a?.title ?? 'The Matrix (1999)'} required />
            </label>
            <label>
              Subtitle (state line)
              <input type="text" name="subtitle" value={a?.subtitle ?? 'Sci-Fi · Dir. The Wachowskis'} />
            </label>
            <label>
              Large image URL (public HTTPS)
              <input
                type="url"
                name="largeImage"
                value={a?.largeImage?.url ?? 'https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg'}
              />
            </label>
            <label>
              Small image URL (square)
              <input type="url" name="smallImage" value={a?.smallImage?.url ?? ''} />
            </label>
            <label>
              Length (minutes, 0 = no progress bar)
              <input type="number" name="minutes" value="136" min="0" />
            </label>
            <label>
              Already elapsed (minutes)
              <input type="number" name="elapsed" value="10" min="0" />
            </label>
            <label>
              <input type="checkbox" name="paused" checked={!!a?.paused} />
              Paused
            </label>
            <label>
              Button (optional)
              <input type="text" name="linkLabel" placeholder="Label" value={a?.links?.[0]?.label ?? ''} />
              <input type="url" name="linkUrl" placeholder="https://…" value={a?.links?.[0]?.url ?? ''} />
            </label>
            <div class="actions">
              <button>Set activity</button>
            </div>
          </form>
          {a && (
            <form method="post" action={`${ctx.routeBase}/clear`} class="actions">
              <span class="muted">Current: {describeActivity(a)}</span>
              <button class="secondary">Clear</button>
            </form>
          )}
        </div>
      );
    },
  };
}

export const manualPlugin = defineSource({
  id: 'manual',
  name: 'Manual',
  description: 'Set an activity by hand from this UI; useful for testing outputs.',
  configSchema,
  multiple: true,
  create: createManual,
});
