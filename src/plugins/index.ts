import type { Plugin } from '../core/plugin.js';
import { discordPlugin } from './discord/index.js';
import { discordStatusPlugin } from './discord/status.js';
import { calendarFeedPlugin } from './feeds/calendar.js';
import { jsonFeedPlugin } from './feeds/json.js';
import { icalPlugin } from './ical/index.js';
import { jellyfinPlugin } from './jellyfin/index.js';
import { manualPlugin } from './manual/index.js';
import { nintendoPlugin } from './nintendo/index.js';
import { scrobblerPlugin } from './scrobbler/index.js';
import { steamPlugin } from './steam/index.js';
import { tautulliPlugin } from './tautulli/index.js';
import { traktPlugin } from './trakt/index.js';

/**
 * Every available plugin. To add one, implement `defineSource`, `defineHistorySource` or
 * `defineOutput` and list it here.
 */
export const plugins: Plugin[] = [
  discordPlugin,
  calendarFeedPlugin,
  jsonFeedPlugin,
  tautulliPlugin,
  jellyfinPlugin,
  traktPlugin,
  scrobblerPlugin,
  nintendoPlugin,
  steamPlugin,
  manualPlugin,
  icalPlugin,
  discordStatusPlugin,
];
