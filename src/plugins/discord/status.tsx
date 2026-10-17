import { z } from 'zod';
import type { ActivityKind } from '../../core/activity.js';
import type { HistoryObservation } from '../../core/history.js';
import { defineHistorySource, type HistorySourceContext, type InstanceStatus } from '../../core/plugin.js';
import type { GatewaySession } from './gateway.js';
import { discordStatusProvider, watchDiscordStatus, type DiscordStatusSnapshot } from './status-bus.js';

const RECORD = { title: 'What to record', description: 'Activities your Discord clients show: games Discord detects, Spotify, and apps with their own Discord status.' };

const configSchema = z.object({
  kinds: z.array(z.enum(['playing', 'listening', 'watching'])).default(['playing', 'listening', 'watching']).meta({
    title: 'Kinds', group: RECORD, labels: { playing: 'Playing', listening: 'Listening', watching: 'Watching' },
  }),
  ignore: z.array(z.string().trim().min(1)).default([]).meta({
    title: 'Ignore apps', group: RECORD, widget: 'chips', placeholder: 'e.g. Spotify',
    description: 'Activity names to leave out, e.g. Spotify when Last.fm already records your music.',
  }),
});

type Config = z.infer<typeof configSchema>;

/** Discord activity types: 0 Playing, 1 Streaming, 2 Listening, 3 Watching, 4 Custom status, 5 Competing. */
const KINDS: Record<number, ActivityKind> = { 0: 'playing', 2: 'listening', 3: 'watching', 5: 'playing' };

/**
 * What your own Discord clients show, as history entries. Understudy's own activity is left out
 * (the no-echo rule): its sessions are already excluded, and activities from its application id
 * are skipped too. The same activity on several clients is recorded once.
 */
export function statusObservations(sessions: GatewaySession[], options: { applicationId?: string; kinds: ActivityKind[]; ignore: string[] }): HistoryObservation[] {
  const ignored = new Set(options.ignore.map((name) => name.toLowerCase()));
  const seen = new Map<string, HistoryObservation>();
  for (const session of sessions) {
    for (const activity of session.activities ?? []) {
      const kind = KINDS[activity.type ?? 0];
      const name = activity.name?.trim();
      if (!kind || !name || !options.kinds.includes(kind) || ignored.has(name.toLowerCase())) continue;
      if (options.applicationId && activity.application_id === options.applicationId) continue;
      // Games keep one entry per session; rich presence details (scores, levels) change constantly.
      const observation: HistoryObservation = kind === 'playing'
        ? { key: `discord:playing:${activity.application_id ?? name}`, kind, title: name }
        : {
            key: `discord:${kind}:${name}:${activity.details ?? ''}:${activity.state ?? ''}`,
            kind,
            title: activity.details?.trim() || name,
            ...(activity.state?.trim() ? { subtitle: activity.state.trim() } : activity.details?.trim() ? { subtitle: name } : {}),
          };
      seen.set(observation.key, observation);
    }
  }
  return [...seen.values()];
}

const RECHECK_MS = 30_000;

function createStatus(ctx: HistorySourceContext<Config>) {
  let current: HistoryObservation[] = [];
  let snapshot: DiscordStatusSnapshot | undefined;
  let unwatch: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const update = () => {
    if (ctx.signal.aborted) return;
    snapshot = discordStatusProvider()?.snapshot();
    // Without a current session list nothing can be vouched for, so open entries end.
    current = snapshot?.connected && snapshot.informed
      ? statusObservations(snapshot.sessions, { applicationId: snapshot.applicationId, kinds: ctx.config.kinds, ignore: ctx.config.ignore })
      : [];
    ctx.history.observe(current);
    if (snapshot?.informed) ctx.reportSuccess?.();
  };

  return {
    start() {
      unwatch = watchDiscordStatus(update);
      // `informed` lapses on its own after a long reconnect, without an event.
      timer = setInterval(update, RECHECK_MS);
      update();
    },
    stop() {
      clearInterval(timer);
      unwatch?.();
    },
    status(): InstanceStatus {
      if (!snapshot) return { health: 'setup', message: 'Add and enable the Discord output; this uses its connection' };
      if (!snapshot.connected) return { health: 'setup', message: 'Connect Discord on the Discord output' };
      if (!snapshot.informed) {
        return snapshot.gatewayState === 'failed'
          ? { health: 'error', message: `Can’t watch your status: ${snapshot.lastError ?? 'connection failed'}` }
          : { health: 'idle', message: 'Connecting to Discord…' };
      }
      if (!snapshot.sessions.length) return { health: 'idle', message: 'You’re not on Discord right now' };
      if (!current.length) return { health: 'idle', message: 'On Discord, with no activity to record' };
      const first = current[0]!;
      return { health: 'ok', message: `Recording ${first.title}${current.length > 1 ? ` and ${current.length - 1} more` : ''}` };
    },
  };
}

export const discordStatusPlugin = defineHistorySource({
  id: 'discord-status',
  name: 'Discord status',
  description: 'Records what your Discord clients show you doing, such as games Discord detects on your PC, through the Discord output’s connection. Never shown back on Discord.',
  service: 'discord',
  configSchema,
  create: createStatus,
});
