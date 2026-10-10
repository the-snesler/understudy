import type { NowPlaying } from '../../core/activity.js';
import type { PlayerSummary } from './client.js';

export interface SteamGame {
  /** `gameid` as Steam reports it. */
  gameId: string;
  /** Set for real Steam apps; not for non-Steam shortcuts, which have no store page. */
  appId?: string;
  name?: string;
}

export interface GameOptions {
  activityName: string;
  smallImage: string;
  storeButton: boolean;
}

/**
 * Whether a `gameid` is a Steam app id. Non-Steam shortcuts (and mods) get a 64-bit game id with
 * type bits above the 32-bit app id, e.g. `12345678901234567890`.
 */
export function isAppId(gameId: string): boolean {
  return /^\d{1,10}$/.test(gameId) && Number(gameId) > 0 && Number(gameId) < 2 ** 32;
}

/** The game the player is in, if any. */
export function currentGame(p: PlayerSummary): SteamGame | undefined {
  const gameId = p.gameid?.trim().replace(/^0$/, '');
  const name = p.gameextrainfo?.trim() || undefined;
  if (!gameId && !name) return undefined;
  const id = gameId || `name:${name}`;
  return { gameId: id, ...(gameId && isAppId(gameId) && { appId: gameId }), ...(name && { name }) };
}

/** Whether the ignore list (app ids or game names, case-insensitive) covers the game. */
export function isIgnored(game: SteamGame, ignore: string[]): boolean {
  const name = game.name?.toLowerCase();
  return ignore.some((entry) => {
    const e = entry.trim().toLowerCase();
    return !!e && (e === game.gameId || e === game.appId || e === name);
  });
}

/** Identity of the game being played; changes when the player switches games. */
export function activityKey(steamId: string, game: SteamGame): string {
  return `steam:${steamId}:${game.gameId}`;
}

export function storeUrl(appId: string): string {
  return `https://store.steampowered.com/app/${appId}/`;
}

export function toNowPlaying(steamId: string, game: SteamGame, opts: GameOptions, image: string | undefined, startedAt: number): NowPlaying {
  const title = game.name ?? (game.appId ? `Steam app ${game.appId}` : 'Non-Steam game');
  const activity: NowPlaying = {
    key: activityKey(steamId, game),
    kind: 'playing',
    name: opts.activityName,
    title,
    startedAt,
  };
  if (image) activity.largeImage = { url: image, text: title };
  if (opts.smallImage) activity.smallImage = { url: opts.smallImage, text: opts.activityName };
  if (opts.storeButton && game.appId) activity.links = [{ label: 'View on Steam', url: storeUrl(game.appId) }];
  return activity;
}
