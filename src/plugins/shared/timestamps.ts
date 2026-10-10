import type { NowPlaying } from '../../core/activity.js';

/**
 * Keep the previous timestamps when the new ones only differ by polling jitter, so outputs don't
 * see a "change" (and re-send) on every poll. Mutates `next`.
 */
export function stabiliseTimestamps(next: NowPlaying, prev: NowPlaying | undefined, driftMs: number): void {
  if (!prev || prev.key !== next.key || prev.paused || next.paused) return;
  if (prev.startedAt === undefined || next.startedAt === undefined) return;
  if (Math.abs(prev.startedAt - next.startedAt) >= driftMs) return;
  next.startedAt = prev.startedAt;
  if (next.endsAt !== undefined && prev.endsAt !== undefined) next.endsAt = prev.endsAt;
}
