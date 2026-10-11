import { z } from 'zod';

export const sharedSettingsSchema = z.object({
  tmdbKey: z.string().trim().default('').meta({
    title: 'TMDB API key',
    group: 'Shared artwork',
    description: 'Used by Plex, Jellyfin, Emby, and Trakt for movie and show posters. Enter a TMDB v3 API key or v4 read access token (themoviedb.org → Settings → API).',
    secret: true,
  }),
});

export type SharedSettings = z.infer<typeof sharedSettingsSchema>;
export const TMDB_SOURCE_PLUGINS = new Set(['tautulli', 'jellyfin', 'trakt']);
