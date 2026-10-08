import type { ActivityImage, ActivityKind, NowPlaying } from '../../core/activity.js';
import type { DiscordActivity } from './headless.js';

export type StatusDisplay = 'name' | 'state' | 'details';

export interface MappingOptions {
  applicationId: string;
  statusDisplay: StatusDisplay;
}

const TYPE: Record<ActivityKind, DiscordActivity['type']> = { playing: 0, listening: 2, watching: 3 };
const STATUS_DISPLAY: Record<StatusDisplay, 0 | 1 | 2> = { name: 0, state: 1, details: 2 };

// Discord's limits for activity text fields and asset strings.
const MAX_TEXT = 128;
const MAX_ASSET = 313;
const MAX_BUTTON_LABEL = 32;
const MAX_BUTTON_URL = 512;

export function toDiscordActivity(np: NowPlaying, opts: MappingOptions): DiscordActivity {
  const activity: DiscordActivity = {
    application_id: opts.applicationId,
    platform: 'desktop',
    supported_platforms: ['desktop'],
    type: TYPE[np.kind],
    name: clip(np.name) || 'Activity',
    status_display_type: STATUS_DISPLAY[opts.statusDisplay],
  };

  const details = text(np.title);
  if (details) activity.details = details;
  const state = text(np.paused ? [np.subtitle, 'Paused'].filter(Boolean).join(' · ') : np.subtitle);
  if (state) activity.state = state;

  // Timestamps drive the elapsed timer / progress bar, which would keep moving while paused.
  if (!np.paused && (np.startedAt || np.endsAt)) {
    activity.timestamps = {};
    if (np.startedAt) activity.timestamps.start = String(Math.floor(np.startedAt));
    if (np.endsAt) activity.timestamps.end = String(Math.floor(np.endsAt));
  }

  const assets: NonNullable<DiscordActivity['assets']> = {};
  const large = image(np.largeImage);
  if (large) {
    assets.large_image = large.url;
    if (large.text) assets.large_text = large.text;
  }
  const small = image(np.smallImage);
  if (small) {
    assets.small_image = small.url;
    if (small.text) assets.small_text = small.text;
  }
  if (Object.keys(assets).length) activity.assets = assets;

  const buttons = (np.links ?? [])
    .filter((l) => l.label.trim() && isHttpsUrl(l.url) && l.url.length <= MAX_BUTTON_URL)
    .slice(0, 2)
    .map((l) => ({ label: l.label.trim().slice(0, MAX_BUTTON_LABEL), url: l.url }));
  if (buttons.length) activity.buttons = buttons;

  return activity;
}

function clip(value: string | undefined, max = MAX_TEXT): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Discord rejects 1-character strings in text fields; pad them rather than drop the line. */
function text(value: string | undefined): string | undefined {
  const v = clip(value);
  if (!v) return undefined;
  return v.length < 2 ? `${v} ` : v;
}

function image(img: ActivityImage | undefined): { url: string; text?: string } | undefined {
  if (!img || !isHttpsUrl(img.url) || img.url.length > MAX_ASSET) return undefined;
  return { url: img.url, text: text(img.text) };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
