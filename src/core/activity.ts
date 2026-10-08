/**
 * The source-agnostic "now playing" model. Sources produce these; outputs decide how to show them.
 */

export type ActivityKind = 'playing' | 'watching' | 'listening';

export interface ActivityImage {
  /** Public HTTPS URL. */
  url: string;
  /** Hover text. */
  text?: string;
}

export interface ActivityLink {
  label: string;
  url: string;
}

export interface NowPlaying {
  /** Stable identity of the item (e.g. `plex:movie:12345`). A new key means a different item. */
  key: string;
  kind: ActivityKind;
  /** Platform or app label shown as the activity name, e.g. "Plex" or "Nintendo Switch". */
  name: string;
  /** Primary line, e.g. the movie, episode, track or game. */
  title: string;
  /** Secondary line, e.g. "by Artist" or "S01E02 · Pilot". */
  subtitle?: string;
  largeImage?: ActivityImage;
  smallImage?: ActivityImage;
  /** Epoch milliseconds. */
  startedAt?: number;
  /** Epoch milliseconds. With `startedAt`, Discord shows a progress bar. */
  endsAt?: number;
  paused?: boolean;
  links?: ActivityLink[];
}

/** A source's current activity, as held by the hub. */
export interface SourceActivity {
  sourceId: string;
  activity: NowPlaying;
  /** Epoch ms of the last time the activity changed (not of every identical re-publish). */
  changedAt: number;
}

const TIMESTAMP_FIELDS = ['startedAt', 'endsAt'] as const;

/**
 * Whether two activities would look the same to a viewer. Timestamps are compared with a tolerance
 * so polling jitter (e.g. a progress offset reported a second late) doesn't count as a change.
 */
export function activitiesEquivalent(
  a: NowPlaying | null | undefined,
  b: NowPlaying | null | undefined,
  toleranceMs = 5_000,
): boolean {
  if (!a || !b) return !a && !b;
  for (const field of TIMESTAMP_FIELDS) {
    const x = a[field];
    const y = b[field];
    if ((x === undefined) !== (y === undefined)) return false;
    if (x !== undefined && y !== undefined && Math.abs(x - y) > toleranceMs) return false;
  }
  const strip = ({ startedAt: _s, endsAt: _e, ...rest }: NowPlaying) => rest;
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

/** JSON.stringify with sorted object keys and `undefined` members dropped. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, inner]) => inner !== undefined)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
      );
    }
    return v;
  });
}

export function describeActivity(a: NowPlaying): string {
  const verb = { playing: 'Playing', watching: 'Watching', listening: 'Listening to' }[a.kind];
  const parts = [`${verb} ${a.name}: ${a.title}`];
  if (a.subtitle) parts.push(a.subtitle);
  if (a.paused) parts.push('(paused)');
  return parts.join(' · ');
}
