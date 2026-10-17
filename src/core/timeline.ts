import type { HistoryKind, HistorySegment } from './history.js';

/** Back-to-back items closer than this read as one session (an album, a binge, a game night). */
export const SESSION_GAP_MS = 5 * 60_000;

/** One or more consecutive history segments from the same source, shown as a single block. */
export interface HistoryGroup {
  /** The first segment's id, so a growing session keeps a stable identity (and calendar UID). */
  id: string;
  sourceId: string;
  kind: HistoryKind;
  origin?: string;
  startedAt: number;
  /** Null while the last segment is still open. */
  endedAt: number | null;
  title: string;
  subtitle?: string;
  items: HistorySegment[];
}

const NOUNS: Record<HistoryKind, string> = { listening: 'tracks', watching: 'episodes', playing: 'sessions', event: 'events' };

/**
 * Merge consecutive segments of the same source and kind into sessions. Calendar events and paused
 * segments are never merged; output segments merge across outputs, since they show the same thing.
 */
export function groupSegments(segments: HistorySegment[], gapMs = SESSION_GAP_MS): HistoryGroup[] {
  const sorted = [...segments].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const open = new Map<string, HistoryGroup>();
  const groups: HistoryGroup[] = [];
  for (const item of sorted) {
    const lane = `${item.sourceId}\u0000${item.kind}`;
    const previous = open.get(lane);
    const mergeable = gapMs > 0 && item.kind !== 'event' && !item.paused;
    if (previous && mergeable && previous.endedAt !== null && item.startedAt - previous.endedAt <= gapMs) {
      previous.items.push(item);
      previous.endedAt = item.endedAt === null ? null : Math.max(previous.endedAt, item.endedAt);
      continue;
    }
    const group: HistoryGroup = {
      id: item.id,
      sourceId: item.sourceId,
      kind: item.kind,
      ...(item.origin ? { origin: item.origin } : {}),
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      items: [item],
    };
    groups.push(group);
    if (mergeable) open.set(lane, group);
    else open.delete(lane);
  }
  for (const group of groups) Object.assign(group, summarize(group.items, group.kind));
  return groups;
}

/** A short title for a session: the album artist, the show, or the first item and a count. */
export function summarize(items: HistorySegment[], kind: HistoryKind): { title: string; subtitle?: string } {
  const first = items[0]!;
  if (items.length === 1) return { title: first.title, subtitle: first.subtitle };
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => !!value))];
  const titles = unique(items.map((item) => item.title));
  const subtitles = unique(items.map((item) => item.subtitle));
  // The same item interrupted (by a short pause, say) is still one item.
  if (titles.length === 1) {
    return { title: first.title, subtitle: subtitles.length > 1 ? `${subtitles.length} ${NOUNS[kind]}` : subtitles[0] };
  }
  // A listening session reads best as its artists.
  if (kind === 'listening' && subtitles.length && subtitles.length <= 3) {
    return { title: subtitles.length === 3 ? `${subtitles[0]}, ${subtitles[1]} and ${subtitles[2]}` : subtitles.join(' and '), subtitle: `${items.length} ${NOUNS[kind]}` };
  }
  return {
    title: `${first.title} and ${titles.length - 1} more`,
    subtitle: subtitles.length ? `${subtitles.slice(0, 2).join(', ')}${subtitles.length > 2 ? ', …' : ''}` : undefined,
  };
}
