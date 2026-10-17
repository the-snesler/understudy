import type { GatewaySession, GatewayState } from './gateway.js';

/**
 * How the Discord status history source sees your Discord sessions: through the Discord output's
 * Gateway connection, so there's one sign-in and one connection. The output keeps its Gateway
 * running while a status source is watching, even when it publishes through a headless session.
 */
export interface DiscordStatusSnapshot {
  /** The output is signed in to Discord. */
  connected: boolean;
  /** The session list is current (connected, or only briefly reconnecting). */
  informed: boolean;
  gatewayState: GatewayState;
  lastError?: string;
  /** Understudy's Discord application: activities from it are Understudy's own, never recorded. */
  applicationId: string;
  /** Your own clients' sessions, without Understudy's connections or headless sessions. */
  sessions: GatewaySession[];
}

export interface DiscordStatusProvider {
  instanceId: string;
  snapshot(): DiscordStatusSnapshot;
  /** Start or stop the Gateway to match whether anyone is watching. */
  sync(): void;
}

const providers = new Map<string, DiscordStatusProvider>();
const listeners = new Set<() => void>();

export function provideDiscordStatus(provider: DiscordStatusProvider): () => void {
  providers.set(provider.instanceId, provider);
  notifyDiscordStatus();
  return () => {
    if (providers.get(provider.instanceId) === provider) providers.delete(provider.instanceId);
    notifyDiscordStatus();
  };
}

export function discordStatusProvider(): DiscordStatusProvider | undefined {
  return providers.values().next().value;
}

export function watchDiscordStatus(listener: () => void): () => void {
  listeners.add(listener);
  for (const provider of providers.values()) provider.sync();
  return () => {
    listeners.delete(listener);
    for (const provider of providers.values()) provider.sync();
  };
}

export function discordStatusWatched(): boolean {
  return listeners.size > 0;
}

export function notifyDiscordStatus(): void {
  for (const listener of listeners) listener();
}
