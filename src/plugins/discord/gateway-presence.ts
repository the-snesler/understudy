import { errorMessage, type Logger } from '../../core/log.js';
import type { DiscordApi } from './api.js';
import type { DiscordGateway, GatewayActivity } from './gateway.js';
import type { DiscordActivity } from './headless.js';
import type { SessionLike } from './publisher.js';

const MAX_CACHE = 500;

/**
 * Publishes through our Gateway session's presence instead of a headless session. Converts the
 * headless-style activity to the Gateway shape: external image URLs must first be registered with
 * Discord's media proxy (`mp:external/...`), and buttons are sent as labels plus `metadata.button_urls`.
 */
export class GatewayPresence implements SessionLike {
  private readonly proxied = new Map<string, string>();

  constructor(
    private readonly gateway: DiscordGateway,
    private readonly api: DiscordApi,
    private readonly applicationId: string,
    private readonly log: Logger,
  ) {}

  get active(): boolean {
    return this.gateway.showing;
  }

  async upsert(activity: DiscordActivity): Promise<void> {
    this.gateway.setActivity(await this.convert(activity));
  }

  async clear(): Promise<void> {
    this.gateway.setActivity(null);
  }

  async convert(d: DiscordActivity): Promise<GatewayActivity> {
    const out: GatewayActivity = { type: d.type, name: d.name, application_id: d.application_id };
    if (d.details) out.details = d.details;
    if (d.state) out.state = d.state;
    if (d.status_display_type !== undefined) out.status_display_type = d.status_display_type;
    if (d.timestamps) {
      out.timestamps = {};
      if (d.timestamps.start) out.timestamps.start = Number(d.timestamps.start);
      if (d.timestamps.end) out.timestamps.end = Number(d.timestamps.end);
    }
    if (d.assets) {
      const urls = [d.assets.large_image, d.assets.small_image].filter((u): u is string => !!u && /^https?:\/\//.test(u));
      await this.register(urls);
      const asset = (v: string | undefined) => (v && /^https?:\/\//.test(v) ? this.proxied.get(v) : v);
      const assets: NonNullable<GatewayActivity['assets']> = {};
      const large = asset(d.assets.large_image);
      const small = asset(d.assets.small_image);
      if (large) {
        assets.large_image = large;
        if (d.assets.large_text) assets.large_text = d.assets.large_text;
      }
      if (small) {
        assets.small_image = small;
        if (d.assets.small_text) assets.small_text = d.assets.small_text;
      }
      if (Object.keys(assets).length) out.assets = assets;
    }
    if (d.buttons?.length) {
      out.buttons = d.buttons.map((b) => b.label);
      out.metadata = { button_urls: d.buttons.map((b) => b.url) };
    }
    return out;
  }

  /** Register external image URLs with Discord's media proxy; failures just drop the image. */
  private async register(urls: string[]): Promise<void> {
    const missing = [...new Set(urls)].filter((u) => !this.proxied.has(u));
    if (!missing.length) return;
    try {
      const res = await this.api.request<{ url: string; external_asset_path: string }[]>(
        'POST',
        `/applications/${this.applicationId}/external-assets`,
        { urls: missing },
      );
      for (const item of res.body ?? []) this.proxied.set(item.url, `mp:${item.external_asset_path}`);
      while (this.proxied.size > MAX_CACHE) this.proxied.delete(this.proxied.keys().next().value!);
    } catch (err) {
      this.log.warn(`Could not register artwork with Discord: ${errorMessage(err)}`);
    }
  }
}
