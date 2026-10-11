import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { HubRules } from '../src/core/hub.js';
import { OutputRulesCard } from '../src/web/settings.js';

const hubRules: HubRules = { paused: 'hide', quietHours: '23:00-07:00', timeZone: 'America/Chicago' };

async function render(rules?: Partial<HubRules>, values?: Partial<HubRules>) {
  const registry = {
    hubRules: () => hubRules,
    sources: () => [{ id: 'plex', label: 'Plex', enabled: true }],
  };
  const view = {
    label: 'Discord',
    config: { id: 'discord', plugin: 'discord', enabled: true, config: {}, rules },
  };
  const app = new Hono();
  app.get('/', (c) => c.html(<OutputRulesCard registry={registry} view={view} values={values} />));
  return (await app.request('/')).text();
}

function summary(html: string, label: string) {
  const rows = html.match(/<div class="rule-row">.*?<\/strong><\/div>/g) ?? [];
  return rows
    .map((row) => row.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
    .find((row) => row.startsWith(`${label} `));
}

describe('effective output rules summary', () => {
  it('identifies Hub values as inherited when there are no overrides', async () => {
    const html = await render();
    expect(summary(html, 'Priority')).toBe('Priority Plex Inherited from Hub');
    expect(summary(html, 'Paused media')).toBe('Paused media Hide Inherited from Hub');
    expect(summary(html, 'Quiet hours')).toBe('Quiet hours 23:00-07:00 Inherited from Hub');
    expect(summary(html, 'Time zone')).toBe('Time zone America/Chicago Inherited from Hub');
    expect(html).not.toContain('Output override');
  });

  it('shows full overrides in both the summary and editable fields, including explicitly disabled quiet hours', async () => {
    const html = await render({ paused: 'show', quietHours: '', timeZone: 'Asia/Tokyo' });
    expect(summary(html, 'Paused media')).toBe('Paused media Show Output override');
    expect(summary(html, 'Quiet hours')).toBe('Quiet hours Off Output override');
    expect(summary(html, 'Time zone')).toBe('Time zone Asia/Tokyo Output override');
    expect(summary(html, 'Priority')).toBe('Priority Plex Inherited from Hub');
    expect(html).toContain('<option value="show" selected="">Show</option>');
    expect(html).toContain('name="rules.quietHours" value=""');
    expect(html).toContain('name="rules.timeZone" value="Asia/Tokyo"');
  });

  it('marks only omitted fields as inherited for partial overrides', async () => {
    const html = await render({ paused: 'last' });
    expect(summary(html, 'Paused media')).toBe('Paused media Show last Output override');
    expect(summary(html, 'Quiet hours')).toBe('Quiet hours 23:00-07:00 Inherited from Hub');
    expect(summary(html, 'Time zone')).toBe('Time zone America/Chicago Inherited from Hub');
    expect(html).toContain('name="rules.timeZone" value="America/Chicago"');
  });

  it('identifies explicitly configured fields as overrides even when they equal the Hub', async () => {
    const html = await render({ paused: hubRules.paused, timeZone: hubRules.timeZone });
    expect(summary(html, 'Paused media')).toBe('Paused media Hide Output override');
    expect(summary(html, 'Time zone')).toBe('Time zone America/Chicago Output override');
    expect(summary(html, 'Quiet hours')).toBe('Quiet hours 23:00-07:00 Inherited from Hub');
  });

  it('summarizes submitted values when redisplaying the form instead of the saved overrides', async () => {
    const html = await render({ paused: 'hide', quietHours: '23:00-07:00' }, { paused: 'show', quietHours: '' });
    expect(summary(html, 'Paused media')).toBe('Paused media Show Output override');
    expect(summary(html, 'Quiet hours')).toBe('Quiet hours Off Output override');
    expect(summary(html, 'Time zone')).toBe('Time zone America/Chicago Inherited from Hub');
  });
});
