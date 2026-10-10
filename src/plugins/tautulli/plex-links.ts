import type { ActivityLink } from '../../core/activity.js';
import { errorMessage, type Logger } from '../../core/log.js';
import type { TautulliSession } from './client.js';
import { mediaKind, sessionKey } from './session.js';

/**
 * Public Plex pages for a session, built from its `plex://` guids (Plex's own agents; items matched
 * by legacy agents or not matched at all have none).
 *
 * - Tracks: `listen.plex.tv/track/<id>`, straight from the track guid.
 * - Movies and shows: Plex's metadata provider answers without a token for these and gives the
 *   `watch.plex.tv` URL (`publicPagesURL`), slug and all.
 * - Episodes: the show's page plus `/season/N/episode/M`. Plex's numbering doesn't always match the
 *   library's (e.g. anime split into seasons differently), so the episode page is checked first and
 *   the show's page used if it doesn't exist.
 */

const LABEL = 'View on Plex';
const PROVIDER = 'https://metadata.provider.plex.tv/library/metadata';
const MAX_CACHE = 200;
const FAILURE_TTL_MS = 10 * 60 * 1000;

/** The id in a `plex://<type>/<id>` guid. */
export function plexGuidId(guid: string | undefined, type: string): string | undefined {
  const m = /^plex:\/\/([a-z]+)\/([0-9a-f]+)$/i.exec(guid ?? '');
  return m && m[1] === type ? m[2] : undefined;
}

export class PlexLinks {
  private readonly cache = new Map<string, { at: number; failed: boolean; value: ActivityLink | undefined }>();

  constructor(
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async resolve(s: TautulliSession): Promise<ActivityLink | undefined> {
    const key = sessionKey(s);
    const hit = this.cache.get(key);
    if (hit && (!hit.failed || Date.now() - hit.at < FAILURE_TTL_MS)) return hit.value;

    let failed = false;
    let url: string | undefined;
    try {
      url = await this.lookup(s);
    } catch (err) {
      failed = true;
      this.log.warn(`Plex link lookup failed for "${s.full_title ?? s.title}": ${errorMessage(err)}`);
    }
    const value = url ? { label: LABEL, url } : undefined;
    this.cache.set(key, { at: Date.now(), failed, value });
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private async lookup(s: TautulliSession): Promise<string | undefined> {
    switch (mediaKind(s)) {
      case 'track': {
        const id = plexGuidId(s.guid, 'track');
        return id && `https://listen.plex.tv/track/${id}`;
      }
      case 'movie': {
        const id = plexGuidId(s.guid, 'movie');
        return id && this.publicPage(id);
      }
      case 'episode': {
        const id = plexGuidId(s.grandparent_guid, 'show');
        const show = id && (await this.publicPage(id));
        if (!show) return undefined;
        const season = Number(s.parent_media_index);
        const episode = Number(s.media_index);
        if (!Number.isInteger(season) || !Number.isInteger(episode)) return show;
        const page = `${show}/season/${season}/episode/${episode}`;
        return (await this.exists(page)) ? page : show;
      }
      default:
        return undefined;
    }
  }

  /** The `watch.plex.tv` page for a movie or show. */
  private async publicPage(id: string): Promise<string | undefined> {
    const res = await this.fetchImpl(`${PROVIDER}/${id}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Without a token the provider only answers for movies and shows, and says 401 for anything else.
    if (res.status === 401 || res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Plex metadata request failed (${res.status})`);
    const body = (await res.json()) as { MediaContainer?: { Metadata?: Array<{ publicPagesURL?: string }> } };
    const url = body.MediaContainer?.Metadata?.[0]?.publicPagesURL?.replace(/\/+$/, '');
    return url?.startsWith('https://') ? url : undefined;
  }

  private async exists(url: string): Promise<boolean> {
    const res = await this.fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(this.timeoutMs) });
    return res.ok;
  }
}
