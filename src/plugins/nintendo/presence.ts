import type { NowPlaying } from '../../core/activity.js';
import { renderTemplate, type TemplateVars } from '../../core/template.js';
import type { FriendInfo } from './client.js';

export interface PresenceOptions {
  /** Activity name; empty = "Nintendo Switch" or "Nintendo Switch 2" from the console. */
  activityName: string;
  titleTemplate: string;
  subtitleTemplate: string;
  smallImage: string;
  eshopButton: boolean;
}

const PLAYING_STATES = new Set(['ONLINE', 'PLAYING']);

export function consoleName(platform: number | undefined): string {
  return platform === 2 ? 'Nintendo Switch 2' : 'Nintendo Switch';
}

/** e.g. "45 minutes", "12 hours". Nintendo reports total play time in minutes. */
export function formatPlayTime(minutes: number): string {
  if (!minutes) return '';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Identity of what the friend is doing; changes when they switch games. */
export function presenceKey(f: FriendInfo): string | undefined {
  const game = f.presence.game;
  if (!PLAYING_STATES.has(f.presence.state) || !game) return undefined;
  return `nintendo:${f.nsaId}:${game.name}`;
}

export function templateVars(f: FriendInfo): TemplateVars {
  const game = f.presence.game;
  return {
    game: game?.name,
    description: game?.sysDescription,
    console: consoleName(f.presence.platform),
    playTime: game ? formatPlayTime(game.totalPlayTime) : '',
    online: f.presence.state === 'PLAYING' ? 'Playing online' : '',
    name: f.name,
  };
}

/** The friend's presence as an activity, or null if they aren't playing anything. */
export function toNowPlaying(f: FriendInfo, opts: PresenceOptions, startedAt: number): NowPlaying | null {
  const key = presenceKey(f);
  const game = f.presence.game;
  if (!key || !game) return null;
  const vars = templateVars(f);
  const activity: NowPlaying = {
    key,
    kind: 'playing',
    name: opts.activityName || consoleName(f.presence.platform),
    title: renderTemplate(opts.titleTemplate, vars) || game.name,
    startedAt,
  };
  const subtitle = renderTemplate(opts.subtitleTemplate, vars);
  if (subtitle) activity.subtitle = subtitle;
  if (game.imageUri) activity.largeImage = { url: game.imageUri, text: game.name };
  if (opts.smallImage) activity.smallImage = { url: opts.smallImage, text: consoleName(f.presence.platform) };
  if (opts.eshopButton && game.shopUri.startsWith('https://')) activity.links = [{ label: 'Nintendo eShop', url: game.shopUri }];
  return activity;
}
