import { LogBuffer, Logger } from '../src/core/log.js';
import type { NowPlaying } from '../src/core/activity.js';

export function quietLogger(): Logger {
  return new Logger(new LogBuffer(), 'test', 'error');
}

export function movie(overrides: Partial<NowPlaying> = {}): NowPlaying {
  return {
    key: 'plex:movie:1',
    kind: 'watching',
    name: 'Plex',
    title: 'The Matrix (1999)',
    subtitle: 'Sci-Fi',
    startedAt: 1_000_000,
    endsAt: 9_000_000,
    ...overrides,
  };
}

export interface FakeCall {
  method: string;
  url: string;
  body: unknown;
}

/** A scripted `fetch`: each call takes the next response from the queue. */
export function scriptedFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: FakeCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch #${calls.length}: ${init?.method} ${String(input)}`);
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  }) as typeof fetch;
  return { impl, calls };
}
