/**
 * Album art lookups for music, using keyless public APIs. Plex album names rarely match a store's
 * exactly ("Outer Wilds - Reprise" vs "Outer Wilds - Reprise - Single"), and iTunes' text search
 * misses some albums outright ("SMILE! :D"), so this tries several strategies:
 *
 * 1. iTunes album search for "artist album";
 * 2. the artist's full iTunes discography (artist lookup → albums), matched by name;
 * 3. Deezer album search.
 */

export interface AlbumArt {
  url: string;
  source: 'itunes' | 'deezer';
}

interface ItunesAlbum {
  wrapperType?: string;
  collectionName?: string;
  artistName?: string;
  artworkUrl100?: string;
}

const squash = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, '');
const SOUNDTRACK_WORDS =
  /\b(?:(?:original|official)\s+)?(?:(?:video\s+)?game|motion\s+picture|television|tv|series|animated\s+series)?\s*(?:soundtrack|score|ost)\b/g;

/**
 * Comparison keys for an album name, strictest first:
 * 1. punctuation and case ignored ("Chapter 5: OGS" = "Chapter 5 (OGS)");
 * 2. also without bracketed parts and " - Single"/" - EP" ("Nurture (Deluxe)" = "Nurture");
 * 3. also without soundtrack wording ("Norse Lands" = "Norse Lands Soundtrack (Extended)").
 */
export function albumKeys(name = ''): string[] {
  const base = name.normalize('NFKC').toLowerCase().replace(/\s+-\s+(single|ep)\s*$/, '');
  const unbracketed = base.replace(/\s*[([{].*?[)\]}]\s*/g, ' ');
  const keys = [squash(base), squash(unbracketed), squash(unbracketed.replace(SOUNDTRACK_WORDS, ' '))];
  return keys.map((k, i) => k || keys[i - 1] || '');
}

/** Album name with punctuation, case, brackets and store suffixes ignored. */
export function normaliseAlbum(name = ''): string {
  return albumKeys(name)[1]!;
}

/** How well two album names match: 3 (best) to 1, or 0 for no match. */
function albumScore(wanted: string[], candidate: string | undefined): number {
  const c = albumKeys(candidate);
  for (let i = 0; i < wanted.length; i++) if (wanted[i] && wanted[i] === c[i]) return 3 - i;
  return 0;
}

function normaliseArtist(name = ''): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** "Porter Robinson" matches "Porter Robinson & Madeon"; empty or "Various Artists" matches anything. */
function artistMatches(wanted: string, candidate: string | undefined): boolean {
  const w = normaliseArtist(wanted);
  if (!w || w === 'variousartists') return true;
  const c = normaliseArtist(candidate);
  return c.includes(w) || (c.length > 0 && w.includes(c));
}

export class AlbumArtFinder {
  private readonly artistIds = new Map<string, number | undefined>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async find(artist: string, album: string): Promise<AlbumArt | undefined> {
    if (!album) return undefined;
    const wanted = albumKeys(album);
    const pick = <T>(items: T[], name: (t: T) => string | undefined, by: (t: T) => string | undefined): T | undefined => {
      let best: T | undefined;
      let bestScore = 0;
      for (const item of items) {
        const score = artistMatches(artist, by(item)) ? albumScore(wanted, name(item)) : 0;
        if (score > bestScore) [best, bestScore] = [item, score];
      }
      return best;
    };

    const searched = await this.itunes<ItunesAlbum>({ term: `${artist} ${album}`.trim(), media: 'music', entity: 'album', limit: '25' });
    let hit = pick(searched, (r) => r.collectionName, (r) => r.artistName);

    if (!hit && artist) {
      const id = await this.itunesArtistId(artist);
      if (id) {
        const albums = await this.itunes<ItunesAlbum>({ id: String(id), entity: 'album', limit: '200' }, 'lookup');
        hit = pick(
          albums.filter((r) => r.wrapperType === 'collection'),
          (r) => r.collectionName,
          (r) => r.artistName,
        );
      }
    }
    if (hit?.artworkUrl100) {
      return { url: hit.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.jpg'), source: 'itunes' };
    }

    const deezer = await this.deezer(`${artist} ${album}`.trim());
    const dz = pick(deezer, (r) => r.title, (r) => r.artist?.name);
    if (dz?.cover_xl) return { url: dz.cover_xl, source: 'deezer' };
    return undefined;
  }

  private async itunesArtistId(artist: string): Promise<number | undefined> {
    const key = normaliseArtist(artist);
    if (this.artistIds.has(key)) return this.artistIds.get(key);
    const results = await this.itunes<{ artistName?: string; artistId?: number }>({
      term: artist,
      media: 'music',
      entity: 'musicArtist',
      limit: '5',
    });
    const id = results.find((r) => normaliseArtist(r.artistName) === key)?.artistId;
    this.artistIds.set(key, id);
    return id;
  }

  private async itunes<T>(params: Record<string, string>, endpoint: 'search' | 'lookup' = 'search'): Promise<T[]> {
    const url = new URL(`https://itunes.apple.com/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`iTunes ${endpoint} failed (${res.status})`);
    return ((await res.json()) as { results?: T[] }).results ?? [];
  }

  private async deezer(q: string): Promise<{ title?: string; artist?: { name?: string }; cover_xl?: string }[]> {
    const url = new URL('https://api.deezer.com/search/album');
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '25');
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Deezer search failed (${res.status})`);
    const body = (await res.json()) as { data?: { title?: string; artist?: { name?: string }; cover_xl?: string }[]; error?: unknown };
    if (body.error) throw new Error(`Deezer search failed: ${JSON.stringify(body.error)}`);
    return body.data ?? [];
  }
}
