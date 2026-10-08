import { activitiesEquivalent, type NowPlaying, type SourceActivity } from './activity.js';

export interface HubState {
  /** Current activity per source instance that has one, in no particular order. */
  activities: SourceActivity[];
}

export type HubListener = (state: HubState) => void;

/** Holds every source's current activity and tells outputs when anything changes. */
export class Hub {
  private readonly current = new Map<string, SourceActivity>();
  private readonly listeners = new Set<HubListener>();

  constructor(private readonly now: () => number = Date.now) {}

  set(sourceId: string, activity: NowPlaying | null): void {
    const prev = this.current.get(sourceId);
    if (!activity) {
      if (!prev) return;
      this.current.delete(sourceId);
    } else {
      if (prev && activitiesEquivalent(prev.activity, activity, 0)) return;
      this.current.set(sourceId, { sourceId, activity, changedAt: this.now() });
    }
    this.emit();
  }

  get(sourceId: string): SourceActivity | undefined {
    return this.current.get(sourceId);
  }

  snapshot(): HubState {
    return { activities: [...this.current.values()] };
  }

  subscribe(listener: HubListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}
