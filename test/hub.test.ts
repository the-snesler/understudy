import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub, defaultHubRules, hubRulesSchema, selectActivity } from '../src/core/hub.js';
import { migrateAppConfig, type AppConfig } from '../src/core/registry.js';
import { movie } from './helpers.js';

const sources = ['plex', 'switch', 'other'].map((id) => ({ id, label: id, enabled: true }));
const entry = (sourceId: string, changedAt: number, paused = false) => ({
  sourceId, changedAt, activity: movie({ key: sourceId, paused }),
});
const rules = { ...defaultHubRules(), timeZone: 'UTC' };
afterEach(() => vi.useRealTimers());

describe('hub selection', () => {
  it('uses configured source order and recency for unranked sources', () => {
    const activities = [entry('other', 300), entry('switch', 200), entry('plex', 100)];
    expect(selectActivity(activities, rules, sources).selected?.sourceId).toBe('plex');
    expect(selectActivity(activities.slice(0, 2), rules, sources).selected?.sourceId).toBe('switch');
    expect(selectActivity(activities, rules, undefined).selected?.sourceId).toBe('other');
  });

  it('hides, ranks last, or shows paused media without losing full activities', () => {
    const activities = [entry('plex', 100, true), entry('switch', 50)];
    expect(selectActivity(activities, { ...rules, paused: 'last' }, sources).selected?.sourceId).toBe('switch');
    expect(selectActivity(activities, { ...rules, paused: 'show' }, sources).selected?.sourceId).toBe('plex');
    expect(selectActivity(activities, { ...rules, paused: 'hide' }, sources).selected?.sourceId).toBe('switch');
    expect(selectActivity([activities[0]!], { ...rules, paused: 'last' }, sources).selected?.sourceId).toBe('plex');
    expect(selectActivity([activities[0]!], rules, sources)).toMatchObject({ selected: null, selectionReason: 'Paused media is hidden' });
    const hub = new Hub();
    hub.configure(rules, sources);
    hub.set('plex', activities[0]!.activity);
    expect(hub.snapshot().selected).toBeNull();
    expect(hub.snapshot().activities).toHaveLength(1);
    expect(hub.snapshot({ paused: 'show' }).selected?.sourceId).toBe('plex');
  });

  it('ignores disabled sources for selection but retains their source activity', () => {
    const hub = new Hub();
    hub.configure(rules, [{ id: 'plex', label: 'Plex', enabled: false }]);
    hub.set('plex', movie());
    expect(hub.snapshot()).toMatchObject({ selected: null, activities: [expect.objectContaining({ sourceId: 'plex' })] });
  });

  it('applies quiet hours in the selected zone and re-evaluates without source changes', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-08T03:59:45Z') }); // 22:59 Chicago
    const hub = new Hub();
    hub.configure({ ...rules, quietHours: '23:00-07:00', timeZone: 'America/Chicago' }, sources);
    hub.set('plex', movie());
    const listener = vi.fn();
    hub.subscribe(listener);
    hub.start();
    expect(hub.snapshot().selected?.sourceId).toBe('plex');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ selected: null, selectionReason: 'Quiet hours (23:00-07:00)' }));
    expect(hub.snapshot({ quietHours: '' }).selected?.sourceId).toBe('plex');
    expect(hub.snapshot().activities).toHaveLength(1);
    hub.stop();
  });

  it('records source changes and confirmed output changes independently', () => {
    const history = { recordSource: vi.fn(), recordShown: vi.fn() };
    const hub = new Hub(() => 1_000);
    hub.attachHistory(history);
    hub.set('plex', movie());
    hub.set('plex', movie());
    expect(history.recordSource).toHaveBeenCalledExactlyOnceWith('plex', movie(), 1_000);
    expect(history.recordShown).not.toHaveBeenCalled();
    hub.reportShown('discord', hub.snapshot().selected);
    hub.setPaused(true);
    expect(history.recordSource).toHaveBeenCalledTimes(1);
    expect(history.recordShown).toHaveBeenCalledExactlyOnceWith('discord', hub.snapshot().selected, 1_000);
  });

  it('validates quiet-hour and time-zone input', () => {
    expect(hubRulesSchema.safeParse({ quietHours: 'bedtime' }).success).toBe(false);
    expect(hubRulesSchema.safeParse({ timeZone: 'Mars/Olympus' }).success).toBe(false);
  });
});

describe('legacy Discord configuration migration', () => {
  it('moves priority into instance order and rules into the hub only once', () => {
    const legacy: AppConfig = {
      version: 1,
      instances: [
        { id: 'plex', plugin: 'tautulli', enabled: true, config: { url: 'http://tautulli' } },
        { id: 'discord', plugin: 'discord', enabled: true, config: { sourcePriority: ['switch', 'missing', 'switch'], paused: 'last', quietHours: '23:00-07:00', timeZone: 'America/Chicago', applicationId: '123' } },
        { id: 'other', plugin: 'steam', enabled: false, config: {} },
        { id: 'switch', plugin: 'nintendo', enabled: true, config: {} },
      ],
    };
    const migrated = migrateAppConfig(legacy, ['plex', 'other', 'switch']);
    expect(migrated.instances.map((instance) => instance.id)).toEqual(['switch', 'discord', 'plex', 'other']);
    expect(migrated.hub).toEqual({ paused: 'last', quietHours: '23:00-07:00', timeZone: 'America/Chicago' });
    expect(migrated.instances[1]!.config).toEqual({ applicationId: '123' });
    expect(migrateAppConfig(migrated, ['plex', 'other', 'switch'])).toBe(migrated);
    expect(legacy.instances[1]!.config.sourcePriority).toEqual(['switch', 'missing', 'switch']);
  });

  it('preserves explicit hub rules and differing output rules', () => {
    const legacy: AppConfig = { version: 1, hub: rules, instances: [
      { id: 'discord', plugin: 'discord', enabled: true, config: { paused: 'show', quietHours: '', timeZone: 'UTC' }, rules: { quietHours: '12:00-13:00' } },
    ] };
    const migrated = migrateAppConfig(legacy, []);
    expect(migrated.hub).toEqual(rules);
    expect(migrated.instances[0]!.rules).toEqual({ paused: 'show', quietHours: '12:00-13:00' });
    expect(migrated.instances[0]!.config).toEqual({});
  });
});
