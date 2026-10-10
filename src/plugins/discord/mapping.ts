import type { ActivityImage, ActivityKind, ActivityLine, NowPlaying } from '../../core/activity.js';
import type { DiscordActivity } from './headless.js';

export interface MappingOptions {
  applicationId: string;
}

const TYPE: Record<ActivityKind, DiscordActivity['type']> = { playing: 0, listening: 2, watching: 3 };
/** Which field Discord's short status (member list, DMs) shows: 0 = name, 1 = state, 2 = details. */
const STATUS_DISPLAY: Record<ActivityLine, 0 | 1 | 2> = { name: 0, subtitle: 1, title: 2 };

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
    status_display_type: STATUS_DISPLAY[statusLine(np)],
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

/** An empty subtitle would leave the short status as "Paused" (or Discord's fallback), so use the title. */
function statusLine(np: NowPlaying): ActivityLine {
  const line = np.statusLine ?? 'title';
  return line === 'subtitle' && !np.subtitle?.trim() ? 'title' : line;
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

/** Discord app asset keys (Developer Portal → Rich Presence → Art Assets) are lowercase names. */
const ASSET_KEY = /^[a-z0-9_.-]+$/;

/** An external HTTPS URL, or the key of an asset uploaded to the Discord app. */
function image(img: ActivityImage | undefined): { url: string; text?: string } | undefined {
  if (!img || img.url.length > MAX_ASSET) return undefined;
  if (!isHttpsUrl(img.url) && !ASSET_KEY.test(img.url)) return undefined;
  return { url: img.url, text: text(img.text) };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
