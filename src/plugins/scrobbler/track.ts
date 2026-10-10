import type { ActivityLink, NowPlaying } from '../../core/activity.js';
import { renderTemplate, type TemplateVars } from '../../core/template.js';
import type { Scrobble, Service } from './client.js';

/**
 * Turning a now-playing track into an activity, and the timing around it. Neither service says
 * when a track started, and both keep reporting it after playback stops (ListenBrainz until its
 * length has passed, Last.fm for a while), so:
 *
 * - the start is when we first saw the track, and stays put while it's still reported;
 * - a progress bar is only shown when we saw the track start (it replaced something else between
 *   two polls), the length is known, and the end hasn't passed;
 * - a track still reported well after it should have ended (length + grace), or, with no known
 *   length, after a configurable cap, is hidden until something else plays.
 */

/** How long past its length a track may still be reported before it's treated as stopped. */
export const GRACE_MS = 2 * 60 * 1000;

export function templateVars(s: Scrobble): TemplateVars {
  return { track: s.track, artist: s.artist, album: s.album };
}

/** The stable identity of a track; a new key means a different track. */
export function trackKey(service: Service, s: Scrobble): string {
  const prefix = service === 'Last.fm' ? 'lastfm' : 'listenbrainz';
  return `${prefix}:${[s.artist, s.track, s.album ?? ''].join('|').toLowerCase()}`;
}

/** Button to the track's page: Last.fm's own, else MusicBrainz's when the recording id is known. */
export function trackLink(s: Scrobble): ActivityLink | undefined {
  if (s.url) return { label: 'Last.fm', url: s.url };
  if (s.recordingMbid) return { label: 'MusicBrainz', url: `https://musicbrainz.org/recording/${s.recordingMbid}` };
  return undefined;
}

/** The activity for a track, without images or timestamps (those are added separately). */
export function toNowPlaying(
  service: Service,
  s: Scrobble,
  opts: { name: string; titleTemplate: string; subtitleTemplate: string },
): NowPlaying {
  const vars = templateVars(s);
  const activity: NowPlaying = {
    key: trackKey(service, s),
    kind: 'listening',
    name: opts.name,
    title: renderTemplate(opts.titleTemplate, vars) || s.track,
  };
  const subtitle = renderTemplate(opts.subtitleTemplate, vars);
  if (subtitle) activity.subtitle = subtitle;
  return activity;
}

export interface Sighting {
  key: string;
  /** When the track was first seen now-playing. */
  since: number;
  /** Whether we saw it start: the poll before reported nothing or another track. */
  sawStart: boolean;
}

/** Remembers when the current track was first seen. */
export class PlayTracker {
  private current: Sighting | undefined;
  /** Whether the previous poll succeeded, so a new track appearing now started between the two. */
  private watching = false;

  /** Record a successful poll: the now-playing key, or undefined for nothing. */
  update(key: string | undefined, now: number): Sighting | undefined {
    if (!key) this.current = undefined;
    else if (this.current?.key !== key) this.current = { key, since: now, sawStart: this.watching };
    this.watching = true;
    return this.current;
  }

  /** Record a failed poll: whatever appears next may have started while we couldn't see. */
  blind(): void {
    this.watching = false;
  }
}

export interface Timing {
  startedAt: number;
  endsAt?: number;
  /** When it will be hidden, if ever. */
  hideAt?: number;
  /** Reported for too long: hide it. */
  stale: boolean;
}

export function playTiming(
  seen: Sighting,
  durationMs: number | undefined,
  now: number,
  opts: { progressBar: boolean; maxMs: number },
): Timing {
  const end = durationMs ? seen.since + durationMs : undefined;
  const hideAt = end !== undefined ? end + GRACE_MS : opts.maxMs > 0 ? seen.since + opts.maxMs : undefined;
  const timing: Timing = { startedAt: seen.since, stale: hideAt !== undefined && now >= hideAt };
  if (hideAt !== undefined) timing.hideAt = hideAt;
  // A bar that's already full (paused, or the service is slow to move on) would look broken.
  if (opts.progressBar && seen.sawStart && end !== undefined && end > now) timing.endsAt = end;
  return timing;
}
