import type { ActivityKind, NowPlaying } from '../../core/activity.js';
import { renderTemplate, type TemplateVars } from '../../core/template.js';
import type { TautulliSession } from './client.js';

export type MediaKind = 'movie' | 'episode' | 'track' | 'other';

export interface Templates {
  movieTitle: string;
  movieSubtitle: string;
  episodeTitle: string;
  episodeSubtitle: string;
  trackTitle: string;
  trackSubtitle: string;
}

export interface SessionFilter {
  /** Plex usernames or Tautulli friendly names (case-insensitive). Empty = everyone. */
  users: string[];
  /** Player names (case-insensitive). Empty = any player. */
  players: string[];
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

export function mediaKind(s: TautulliSession): MediaKind {
  if (s.media_type === 'movie' || s.media_type === 'episode' || s.media_type === 'track') return s.media_type;
  return 'other';
}

export function matchesFilter(s: TautulliSession, f: SessionFilter): boolean {
  const lower = (xs: string[]) => xs.map((x) => x.trim().toLowerCase()).filter(Boolean);
  const users = lower(f.users);
  const players = lower(f.players);
  if (users.length) {
    const names = [s.user, s.username, s.friendly_name].filter(Boolean).map((n) => n!.toLowerCase());
    if (!names.some((n) => users.includes(n))) return false;
  }
  if (players.length && !players.includes((s.player ?? '').toLowerCase())) return false;
  return true;
}

/** Which session to show when several match: playing beats paused, then video beats music. */
export function chooseSession(sessions: TautulliSession[]): TautulliSession | undefined {
  const score = (s: TautulliSession) => (s.state === 'paused' ? 0 : 2) + (mediaKind(s) === 'track' ? 0 : 1);
  return [...sessions].filter((s) => mediaKind(s) !== 'other' || s.title).sort((a, b) => score(b) - score(a))[0];
}

export function templateVars(s: TautulliSession): TemplateVars {
  const pad = (v: unknown) => {
    const n = num(v);
    return n === undefined ? '' : String(n).padStart(2, '0');
  };
  return {
    title: s.title,
    year: num(s.year),
    show: s.grandparent_title,
    season: num(s.parent_media_index),
    episode: num(s.media_index),
    seasonPadded: pad(s.parent_media_index),
    episodePadded: pad(s.media_index),
    episodeTitle: s.title,
    track: s.title,
    // For tracks, original_title holds the track artist when it differs from the album artist.
    artist: s.original_title || s.grandparent_title,
    album: s.parent_title,
    genre: s.genres?.[0],
    genres: s.genres?.join(', '),
    director: s.directors?.[0],
    directors: s.directors?.join(', '),
    studio: s.studio,
    user: s.friendly_name || s.username || s.user,
    player: s.player,
    library: s.library_name,
  };
}

/** The stable identity of what's playing; artwork is cached by it too. */
export function sessionKey(s: TautulliSession): string {
  return `tautulli:${s.rating_key ?? s.session_key ?? s.full_title ?? s.title}`;
}

/**
 * Turn a session into an activity, without images (those are resolved separately, asynchronously).
 * `now` is when the session was fetched, used to turn the playback offset into timestamps.
 */
export function toNowPlaying(
  s: TautulliSession,
  opts: { name: string; templates: Templates; now: number },
): NowPlaying {
  const kind = mediaKind(s);
  const vars = templateVars(s);
  const t = opts.templates;
  let activityKind: ActivityKind = 'watching';
  let title: string;
  let subtitle: string;
  switch (kind) {
    case 'movie':
      title = renderTemplate(t.movieTitle, vars);
      subtitle = renderTemplate(t.movieSubtitle, vars);
      break;
    case 'episode':
      title = renderTemplate(t.episodeTitle, vars);
      subtitle = renderTemplate(t.episodeSubtitle, vars);
      break;
    case 'track':
      activityKind = 'listening';
      title = renderTemplate(t.trackTitle, vars);
      subtitle = renderTemplate(t.trackSubtitle, vars);
      break;
    default:
      title = s.full_title || s.title || 'Something';
      subtitle = num(s.live) ? (s.channel_title ?? 'Live TV') : '';
  }

  const activity: NowPlaying = {
    key: sessionKey(s),
    kind: activityKind,
    name: opts.name,
    title: title || s.full_title || s.title || 'Something',
  };
  if (subtitle) activity.subtitle = subtitle;

  const offset = num(s.view_offset);
  const duration = num(s.duration);
  if (s.state === 'paused') activity.paused = true;
  if (offset !== undefined) {
    activity.startedAt = opts.now - offset;
    if (duration && duration > offset) activity.endsAt = activity.startedAt + duration;
  }
  return activity;
}

/** Thumbnail path for the item's artwork: the show for episodes, the album for tracks. */
export function thumbPath(s: TautulliSession): string | undefined {
  const kind = mediaKind(s);
  if (kind === 'episode') return s.grandparent_thumb || s.parent_thumb || s.thumb;
  if (kind === 'track') return s.parent_thumb || s.grandparent_thumb || s.thumb;
  return s.thumb;
}

/** Rating key whose metadata holds the external ids we want: the show for episodes. */
export function metadataKey(s: TautulliSession): string | undefined {
  return mediaKind(s) === 'episode' ? s.grandparent_rating_key || s.rating_key : s.rating_key;
}
