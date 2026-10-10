import { z } from 'zod';
import { activitiesEquivalent, type NowPlaying, type SourceActivity } from './activity.js';
import type { SourceInfo } from './plugin.js';
import { defaultTimeZone, inWindows, isValidTimeZone, minutesInZone, parseWindows } from './schedule.js';

export const hubRulesSchema = z.object({
  paused: z.enum(['hide', 'last', 'show']).default('hide').meta({
    title: 'Paused media',
    description: 'Hide paused media, show it only when nothing is playing, or keep showing it.',
    widget: 'segmented',
    group: 'Selection',
  }),
  quietHours: z.string().trim().default('').refine((value) => {
    try { parseWindows(value); return true; } catch { return false; }
  }, 'Use time ranges like 23:00-07:00, separated by commas').meta({
    title: 'Quiet hours',
    description: 'Daily times when outputs show nothing, for example 23:00-07:00. Leave empty for none.',
    group: 'Schedule',
  }),
  timeZone: z.string().trim().default(defaultTimeZone()).refine(isValidTimeZone, 'Use a known IANA time zone, such as America/Chicago').meta({
    title: 'Time zone',
    description: 'Used for quiet hours and daily activity totals.',
    group: 'Schedule',
  }),
});

export type HubRules = z.infer<typeof hubRulesSchema>;
export const defaultHubRules = (): HubRules => hubRulesSchema.parse({});

export interface HubSelection {
  selected: SourceActivity | null;
  /** Human-readable explanation, including why nothing can currently be shown. */
  selectionReason: string;
}

export interface HubState extends HubSelection {
  /** Every active source, including ones that selection rules hide. */
  activities: SourceActivity[];
  /** Public outputs withdraw while paused; private history still sees every source. */
  paused?: boolean;
}

export interface HubHistory {
  recordSource(sourceId: string, activity: NowPlaying | null, at?: number): void;
  recordShown(outputId: string, shown: SourceActivity | null, at?: number): void;
}

export type HubListener = (state: HubState) => void;

/** Select from configured source order; recency breaks ties for unranked standalone sources. */
export function selectActivity(
  activities: SourceActivity[],
  rules: HubRules,
  sources: SourceInfo[] | undefined,
  now = Date.now(),
): HubSelection {
  if (rules.quietHours && inWindows(parseWindows(rules.quietHours), minutesInZone(new Date(now), rules.timeZone))) {
    return { selected: null, selectionReason: `Quiet hours (${rules.quietHours})` };
  }
  const enabled = sources && new Set(sources.filter((source) => source.enabled).map((source) => source.id));
  const rank = new Map(sources?.map((source, index) => [source.id, index]));
  const candidates = activities.filter((entry) =>
    (!enabled || enabled.has(entry.sourceId)) && !(rules.paused === 'hide' && entry.activity.paused),
  );
  candidates.sort((a, b) =>
    (rules.paused === 'last' ? Number(!!a.activity.paused) - Number(!!b.activity.paused) : 0) ||
    (rank.get(a.sourceId) ?? rank.size) - (rank.get(b.sourceId) ?? rank.size) ||
    b.changedAt - a.changedAt,
  );
  const selected = candidates[0] ?? null;
  const selectionReason = selected
    ? rules.paused === 'last' && selected.activity.paused
      ? 'Paused media; no source is playing'
      : 'Highest priority, then most recent'
    : activities.some((entry) => (!enabled || enabled.has(entry.sourceId)) && entry.activity.paused) && rules.paused === 'hide'
      ? 'Paused media is hidden'
      : 'No active source';
  return { selected, selectionReason };
}

/** Holds every source and selects the activity shared by outputs. */
export class Hub {
  private readonly current = new Map<string, SourceActivity>();
  private readonly listeners = new Set<HubListener>();
  private paused = false;
  private rules: HubRules = defaultHubRules();
  private sources: SourceInfo[] | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private history: HubHistory | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  attachHistory(history: HubHistory): void {
    this.history = history;
  }

  configure(rules: HubRules, sources: SourceInfo[]): void {
    this.rules = hubRulesSchema.parse(rules);
    this.sources = [...sources];
    this.emit();
  }

  /** Rule boundaries must update outputs even when sources keep reporting the same activity. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleBoundary();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleBoundary(): void {
    if (!this.running) return;
    // Daily rules have minute precision. Re-align each time to avoid accumulating timer drift.
    const delay = 60_000 - ((this.now() % 60_000 + 60_000) % 60_000);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emit();
      this.scheduleBoundary();
    }, delay);
    this.timer.unref?.();
  }

  set(sourceId: string, activity: NowPlaying | null): void {
    const prev = this.current.get(sourceId);
    if (!activity) {
      if (!prev) return;
      this.current.delete(sourceId);
    } else {
      if (prev && activitiesEquivalent(prev.activity, activity, 0)) return;
      this.current.set(sourceId, { sourceId, activity, changedAt: this.now() });
    }
    this.history?.recordSource(sourceId, activity, this.now());
    this.emit();
  }

  /** Outputs report what was actually shown after their own gates and successful sends. */
  reportShown(outputId: string, activity: SourceActivity | null): void {
    this.history?.recordShown(outputId, activity, this.now());
  }

  get(sourceId: string): SourceActivity | undefined {
    return this.current.get(sourceId);
  }

  snapshot(override?: Partial<HubRules>): HubState {
    const activities = [...this.current.values()];
    const rules = override ? hubRulesSchema.parse({ ...this.rules, ...override }) : this.rules;
    return { activities, ...selectActivity(activities, rules, this.sources, this.now()), paused: this.paused };
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.emit();
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
