import type { ActivityKind, NowPlaying } from '../../core/activity.js';
import { renderTemplate, type TemplateVars } from '../../core/template.js';
import type { JellyfinItem, JellyfinSession } from './client.js';

export type MediaKind = 'movie' | 'episode' | 'track' | 'musicVideo' | 'other';

export interface Templates {
  movieTitle: string;
  movieSubtitle: string;
  episodeTitle: string;
  episodeSubtitle: string;
  trackTitle: string;
  trackSubtitle: string;
}

export interface SessionFilter {
  /** Jellyfin/Emby usernames (case-insensitive). Empty = everyone. */
  users: string[];
  /** Client app or device names (case-insensitive). Empty = any. */
  clients: string[];
}

/** Ticks are 100 ns. */
const ticksToMs = (ticks: number | undefined): number | undefined =>
  typeof ticks === 'number' && Number.isFinite(ticks) ? Math.round(ticks / 10_000) : undefined;

export function mediaKind(item: JellyfinItem | undefined): MediaKind {
  switch (item?.Type) {
    case 'Movie':
      return 'movie';
    case 'Episode':
      return 'episode';
    case 'Audio':
      return 'track';
    case 'MusicVideo':
      return 'musicVideo';
    default:
      return 'other';
  }
}

export function matchesFilter(s: JellyfinSession, f: SessionFilter): boolean {
  const lower = (xs: string[]) => xs.map((x) => x.trim().toLowerCase()).filter(Boolean);
  const users = lower(f.users);
  const clients = lower(f.clients);
  if (users.length && !users.includes((s.UserName ?? '').toLowerCase())) return false;
  if (clients.length) {
    const names = [s.Client, s.DeviceName].filter(Boolean).map((n) => n!.toLowerCase());
    if (!names.some((n) => clients.includes(n))) return false;
  }
  return true;
}

/** Whether a session is playing something we can show (photos and slideshows aren't). */
export function isPlaying(s: JellyfinSession): boolean {
  const item = s.NowPlayingItem;
  return !!item && item.MediaType !== 'Photo' && !!(item.Name || item.SeriesName);
}

/** When the session last did something; Jellyfin's check-in time is the better signal when set. */
function lastActive(s: JellyfinSession): number {
  return Math.max(Date.parse(s.LastPlaybackCheckIn ?? '') || 0, Date.parse(s.LastActivityDate ?? '') || 0);
}

/** Which session to show when several match: playing beats paused, then the most recently active. */
export function chooseSession(sessions: JellyfinSession[]): JellyfinSession | undefined {
  const paused = (s: JellyfinSession) => (s.PlayState?.IsPaused ? 1 : 0);
  return sessions.filter(isPlaying).sort((a, b) => paused(a) - paused(b) || lastActive(b) - lastActive(a))[0];
}

export function templateVars(s: JellyfinSession): TemplateVars {
  const item = s.NowPlayingItem ?? {};
  const pad = (n: number | undefined) => (n === undefined ? '' : String(n).padStart(2, '0'));
  return {
    title: item.Name,
    year: item.ProductionYear,
    show: item.SeriesName,
    season: item.ParentIndexNumber,
    episode: item.IndexNumber,
    seasonPadded: pad(item.ParentIndexNumber),
    episodePadded: pad(item.IndexNumber),
    episodeTitle: item.Name,
    track: item.Name,
    // Artists are the track's own; the album artist is often "Various Artists" on compilations.
    artist: item.Artists?.join(', ') || item.AlbumArtist,
    albumArtist: item.AlbumArtist || item.Artists?.[0],
    album: item.Album,
    genre: item.Genres?.[0],
    genres: item.Genres?.join(', '),
    studio: item.Studios?.[0]?.Name,
    rating: item.OfficialRating,
    user: s.UserName,
    client: s.Client,
    device: s.DeviceName,
  };
}

/** The stable identity of what's playing; artwork is cached by it too. */
export function sessionKey(s: JellyfinSession): string {
  const item = s.NowPlayingItem ?? {};
  return `jellyfin:${item.Id ?? `${item.SeriesName ?? ''}/${item.Name ?? ''}`}`;
}

/**
 * Turn a session into an activity, without images (those are resolved separately, asynchronously).
 * `now` is when the session was fetched, used to turn the playback position into timestamps.
 */
export function toNowPlaying(s: JellyfinSession, opts: { name: string; templates: Templates; now: number }): NowPlaying {
  const item = s.NowPlayingItem ?? {};
  const kind = mediaKind(item);
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
    case 'musicVideo':
      if (kind === 'track') activityKind = 'listening';
      title = renderTemplate(t.trackTitle, vars);
      subtitle = renderTemplate(t.trackSubtitle, vars);
      break;
    default:
      // Audiobooks, home videos, live TV, ...: the item's name and whatever it belongs to.
      if (item.MediaType === 'Audio') activityKind = 'listening';
      title = item.Name ?? '';
      subtitle = item.Album || item.SeriesName || (item.Type === 'TvChannel' ? 'Live TV' : '');
  }

  const activity: NowPlaying = {
    key: sessionKey(s),
    kind: activityKind,
    name: opts.name,
    title: title || item.Name || item.SeriesName || 'Something',
  };
  if (subtitle) activity.subtitle = subtitle;
  // "Listening to <track>" means little at a glance; the artist does.
  if (kind === 'track' || kind === 'musicVideo') activity.statusLine = 'subtitle';

  const position = ticksToMs(s.PlayState?.PositionTicks);
  const duration = ticksToMs(item.RunTimeTicks);
  if (s.PlayState?.IsPaused) activity.paused = true;
  if (position !== undefined) {
    activity.startedAt = opts.now - position;
    if (duration && duration > position) activity.endsAt = activity.startedAt + duration;
  }
  return activity;
}

/** Item whose primary image is the artwork: the show for episodes, the album for tracks. */
export function imageItemId(item: JellyfinItem): string | undefined {
  const kind = mediaKind(item);
  const own = item.ImageTags?.Primary && item.Id;
  if (kind === 'episode') return (item.SeriesPrimaryImageTag && item.SeriesId) || own || item.SeriesId || item.Id;
  if (kind === 'track') return (item.AlbumPrimaryImageTag && item.AlbumId) || own || item.AlbumId || item.Id;
  return item.Id;
}
