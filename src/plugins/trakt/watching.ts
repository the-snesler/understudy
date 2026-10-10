import type { ActivityLink, NowPlaying } from '../../core/activity.js';
import { renderTemplate, type TemplateVars } from '../../core/template.js';
import { externalLinks, type ExternalIds, type TmdbType } from '../shared/tmdb.js';
import type { TraktIds, TraktWatching } from './client.js';

export type ItemKind = 'movie' | 'episode';

export interface Templates {
  movieTitle: string;
  movieSubtitle: string;
  episodeTitle: string;
  episodeSubtitle: string;
}

/** Which buttons to add: IMDb (or TMDB), the Trakt page, both, or none. */
export type ButtonMode = 'both' | 'imdb' | 'trakt' | 'none';

const TRAKT_WEB = 'https://trakt.tv';

export function itemKind(w: TraktWatching): ItemKind | undefined {
  if (w.type === 'movie' && w.movie) return 'movie';
  if (w.type === 'episode' && w.episode && w.show) return 'episode';
  return undefined;
}

export function templateVars(w: TraktWatching): TemplateVars {
  const pad = (n: number | undefined) => (n === undefined ? '' : String(n).padStart(2, '0'));
  if (itemKind(w) === 'movie') return { title: w.movie!.title, year: w.movie!.year };
  const { show, episode } = w;
  return {
    title: episode?.title,
    year: show?.year,
    show: show?.title,
    season: episode?.season,
    episode: episode?.number,
    seasonPadded: pad(episode?.season),
    episodePadded: pad(episode?.number),
    episodeTitle: episode?.title,
  };
}

/** The stable identity of what's being watched (the episode, not the show). */
export function itemKey(w: TraktWatching): string {
  const kind = itemKind(w) ?? 'item';
  const ids = (kind === 'movie' ? w.movie?.ids : w.episode?.ids) ?? {};
  const fallback = kind === 'episode' ? `${w.show?.ids?.slug}:${w.episode?.season}x${w.episode?.number}` : (w.movie?.title ?? '?');
  return `trakt:${kind}:${ids.trakt ?? ids.slug ?? fallback}`;
}

/** Ids of the movie, or of the show for episodes: posters and IMDb/TMDB links are per show. */
export function artworkIds(w: TraktWatching): { type: TmdbType; ids: ExternalIds; key: string } {
  const movie = itemKind(w) === 'movie';
  const ids: TraktIds = (movie ? w.movie?.ids : w.show?.ids) ?? {};
  const str = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? undefined : String(v));
  return {
    type: movie ? 'movie' : 'tv',
    ids: { imdb: str(ids.imdb), tmdb: str(ids.tmdb), tvdb: str(ids.tvdb) },
    key: `${movie ? 'movie' : 'show'}:${ids.trakt ?? ids.slug ?? (movie ? w.movie?.title : w.show?.title)}`,
  };
}

/** The item's page on trakt.tv: the movie, or the episode. */
export function traktUrl(w: TraktWatching): string | undefined {
  const slug = (ids: TraktIds | undefined) => ids?.slug ?? (ids?.trakt === undefined ? undefined : String(ids.trakt));
  if (itemKind(w) === 'movie') {
    const s = slug(w.movie?.ids);
    return s && `${TRAKT_WEB}/movies/${s}`;
  }
  const s = slug(w.show?.ids);
  const { season, number } = w.episode ?? {};
  if (!s) return undefined;
  if (season === undefined || number === undefined) return `${TRAKT_WEB}/shows/${s}`;
  return `${TRAKT_WEB}/shows/${s}/seasons/${season}/episodes/${number}`;
}

/** Buttons for the activity. Discord shows at most two. */
export function itemLinks(w: TraktWatching, mode: ButtonMode): ActivityLink[] {
  if (mode === 'none') return [];
  const links: ActivityLink[] = [];
  if (mode === 'both' || mode === 'imdb') {
    const { type, ids } = artworkIds(w);
    links.push(...externalLinks(type, ids));
  }
  const page = traktUrl(w);
  if ((mode === 'both' || mode === 'trakt') && page) links.push({ label: 'Trakt', url: page });
  return links.slice(0, 2);
}

/** Hover text for the poster: the movie or the show. */
export function imageText(w: TraktWatching): string | undefined {
  return (itemKind(w) === 'movie' ? w.movie?.title : w.show?.title) || undefined;
}

/**
 * Turn what Trakt says is being watched into an activity, without images (those are resolved
 * separately). Trakt's `started_at`/`expires_at` give the progress bar.
 */
export function toNowPlaying(w: TraktWatching, opts: { name: string; templates: Templates }): NowPlaying | undefined {
  const kind = itemKind(w);
  if (!kind) return undefined;
  const vars = templateVars(w);
  const t = opts.templates;
  const fallback = (kind === 'movie' ? w.movie?.title : w.show?.title) || 'Something';
  const activity: NowPlaying = {
    key: itemKey(w),
    kind: 'watching',
    name: opts.name,
    title: renderTemplate(kind === 'movie' ? t.movieTitle : t.episodeTitle, vars) || fallback,
  };
  const subtitle = renderTemplate(kind === 'movie' ? t.movieSubtitle : t.episodeSubtitle, vars);
  if (subtitle) activity.subtitle = subtitle;

  const started = Date.parse(w.started_at ?? '');
  const ends = Date.parse(w.expires_at ?? '');
  if (Number.isFinite(started)) {
    activity.startedAt = started;
    if (Number.isFinite(ends) && ends > started) activity.endsAt = ends;
  }
  return activity;
}
