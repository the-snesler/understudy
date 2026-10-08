import type { Plugin } from '../core/plugin.js';
import { discordPlugin } from './discord/index.js';
import { manualPlugin } from './manual/index.js';
import { tautulliPlugin } from './tautulli/index.js';

/** Every available plugin. To add one, implement `defineSource`/`defineOutput` and list it here. */
export const plugins: Plugin[] = [discordPlugin, tautulliPlugin, manualPlugin];
