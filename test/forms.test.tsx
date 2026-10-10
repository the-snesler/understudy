import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseSettingsForm, SettingsFields } from '../src/web/forms.js';

const schema = z.object({
  onlyWhenOnline: z.boolean().default(true).meta({ group: 'When to show' }),
  refreshMinutes: z.number().int().default(5).meta({ group: 'When to show', disabledIf: { field: 'onlyWhenOnline', equals: true } }),
  advanced: z.string().default('saved').meta({ showIf: { field: 'onlyWhenOnline', equals: false } }),
  apiKey: z.string().default('').meta({ group: 'Connection', secret: true }),
  users: z.array(z.string()).default([]).meta({ group: 'Whose streams', widget: 'chips' }),
  pollSeconds: z.number().default(15).meta({ group: 'Connection', widget: 'segmented', options: [5, 15, 30, 60], labels: { '15': '15s' } }),
});

const values = schema.parse({ apiKey: 'do-not-render-secret', users: ['Alice'], pollSeconds: 20 });

async function render() {
  const app = new Hono();
  app.get('/', (c) => c.html(<SettingsFields schema={schema} values={values} context={{ suggestions: { users: ['Bob'] } }} />));
  return (await app.request('/')).text();
}

describe('schema-driven settings forms', () => {
  it('never renders a saved secret and preserves it when another setting changes', async () => {
    const html = await render();
    expect(html).not.toContain('do-not-render-secret');
    expect(html).toContain('data-replace-secret');
    const parsed = parseSettingsForm(schema, { 'cfg.apiKey': '', 'cfg.users': 'Alice\nBob' }, values);
    expect(parsed.apiKey).toBe('do-not-render-secret');
    expect(parsed.users).toEqual(['Alice', 'Bob']);
  });

  it('preserves dependent values while disabled or hidden, including crafted submissions', () => {
    const parsed = parseSettingsForm(schema, {
      'cfg.onlyWhenOnline.__bool': '1', 'cfg.onlyWhenOnline': 'on',
      'cfg.refreshMinutes': '9', 'cfg.advanced': 'changed',
    }, values);
    expect(parsed.refreshMinutes).toBe(5);
    expect(parsed.advanced).toBe('saved');
  });

  it('allows editing fields when their dependency changes in the same submission', () => {
    const parsed = parseSettingsForm(schema, {
      'cfg.onlyWhenOnline.__bool': '1', 'cfg.refreshMinutes': '9', 'cfg.advanced': 'changed',
    }, values);
    expect(parsed.onlyWhenOnline).toBe(false);
    expect(parsed.refreshMinutes).toBe(9);
    expect(parsed.advanced).toBe('changed');
  });

  it('preserves a legacy custom poll interval alongside segmented choices', async () => {
    const html = await render();
    expect(html).toMatch(/value="20"[^>]*checked/);
    expect(parseSettingsForm(schema, { 'cfg.pollSeconds': '20' }, values).pollSeconds).toBe(20);
    expect(html).toContain('Seen recently:');
    expect(html).toContain('data-add-chip="Bob"');
  });
});
