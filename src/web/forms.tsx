import type { Child } from 'hono/jsx';
import { z } from 'zod';
import { Icon } from './icons.js';

/** Presentation metadata stays on the schema, so every plugin uses the same form controls. */
export interface FieldCondition {
  field: string;
  equals?: string | number | boolean;
  not?: string | number | boolean;
}

interface FieldSchema {
  type?: string;
  enum?: unknown[];
  items?: FieldSchema;
  title?: string;
  description?: string;
  secret?: boolean;
  minimum?: number;
  maximum?: number;
  group?: string | { title: string; description?: string };
  widget?: 'chips' | 'segmented' | 'template';
  options?: (string | number | { value: string | number; label: string })[];
  labels?: Record<string, string>;
  placeholder?: string;
  showIf?: FieldCondition;
  disabledIf?: FieldCondition;
  templateTab?: string;
  variables?: string[];
  order?: number;
}

interface Field { key: string; schema: FieldSchema }

export interface FormContext {
  suggestions?: Record<string, string[]>;
  notes?: Record<string, Child>;
}

function fields(schema: z.ZodObject): Field[] {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, FieldSchema>;
  };
  return Object.entries(json.properties ?? {}).map(([key, s]) => ({ key, schema: s }));
}

function matches(condition: FieldCondition | undefined, values: Record<string, unknown>): boolean {
  if (!condition) return false;
  const value = values[condition.field];
  if (condition.not !== undefined) return value !== condition.not;
  return value === (condition.equals ?? true);
}

interface FieldsProps {
  schema: z.ZodObject;
  values: Record<string, unknown>;
  errors?: Record<string, string>;
  context?: FormContext;
  previewUrl?: string;
  groupExtras?: Record<string, Child>;
  afterGroups?: Record<string, Child>;
}

function FieldInput({ field, props }: { field: Field; props: FieldsProps }) {
  const { key, schema: s } = field;
  const value = props.values[key];
  const name = `cfg.${key}`;
  const id = `field-${key}`;
  const title = s.title ?? key;
  const disabled = matches(s.disabledIf, props.values);
  const hidden = s.showIf ? !matches(s.showIf, props.values) : false;
  const helpId = `${id}-help`;
  const error = props.errors?.[key];
  const options = s.options ?? s.enum;
  const help = <>
    {s.description && <div class="help" id={helpId}>{s.description}</div>}
    {props.context?.notes?.[key]}
    {error && <div class="field-error" role="alert">{error}</div>}
  </>;
  const common = { id, name, disabled, 'aria-describedby': s.description ? helpId : undefined, 'aria-invalid': error ? 'true' : undefined };
  let input: Child;
  if (s.type === 'boolean') {
    input = <>
      <div class="switch-row">
        <label for={id} class="field-label">{s.order && <span class="order-badge">{s.order}</span>}{title}</label>
        <input type="hidden" name={`${name}.__bool`} value="1" disabled={disabled} />
        <label class="switch" for={id}><input {...common} type="checkbox" role="switch" checked={value === true} /><span class="switch-track" aria-hidden="true"></span></label>
      </div>
      {help}
    </>;
  } else if (s.type === 'array' && s.items?.enum) {
    const selected = new Set((Array.isArray(value) ? value : []).map(String));
    input = <>
      <div class="field-label" id={`${id}-label`}>{title}</div>
      <input type="hidden" name={`${name}.__set`} value="1" disabled={disabled} />
      <div class="choice-group" role="group" aria-labelledby={`${id}-label`}>
        {s.items.enum.map((opt) => <label class="choice">
          <input type="checkbox" name={name} value={String(opt)} checked={selected.has(String(opt))} disabled={disabled} />
          <span>{s.labels?.[String(opt)] ?? String(opt)}</span>
        </label>)}
      </div>
      {help}
    </>;
  } else if (s.widget === 'segmented' && options) {
    const choices = options.map((opt) => {
      if (typeof opt === 'object' && opt !== null && 'value' in opt) {
        const option = opt as { value: unknown; label?: string };
        return { value: String(option.value), label: option.label ?? String(option.value) };
      }
      return { value: String(opt), label: s.labels?.[String(opt)] ?? String(opt) };
    });
    // Existing configurations may contain a custom interval. Keep it selectable on first save.
    if (value !== undefined && !choices.some((opt) => String(opt.value) === String(value))) choices.push({ value: String(value), label: `${value}s` });
    input = <>
      <div class="field-label" id={`${id}-label`}>{title}</div>
      <div class="segmented" role="radiogroup" aria-labelledby={`${id}-label`}>
        {choices.map((opt) => <label>
          <input type="radio" name={name} value={String(opt.value)} checked={String(opt.value) === String(value)} disabled={disabled} />
          <span>{opt.label}</span>
        </label>)}
      </div>
      {help}
    </>;
  } else if (s.enum) {
    input = <>
      <label for={id} class="field-label">{title}</label>
      <select {...common}>{s.enum.map((opt) => <option value={String(opt)} selected={String(opt) === String(value)}>{s.labels?.[String(opt)] ?? String(opt)}</option>)}</select>
      {help}
    </>;
  } else if (s.type === 'array' && s.widget === 'chips') {
    const values = Array.isArray(value) ? value.map(String) : [];
    input = <>
      <label for={`${id}-entry`} class="field-label">{title}</label>
      <div class="chips-widget" data-chips>
        <textarea {...common} class="chips-value" data-chips-value aria-label={title}>{values.join('\n')}</textarea>
        <div class="chips-control" data-chips-control hidden>
          <div class="chips" data-chips-list></div>
          <input id={`${id}-entry`} type="text" data-chips-entry placeholder={s.placeholder ?? 'Add an item…'} disabled={disabled} autocomplete="off" />
        </div>
        {!!props.context?.suggestions?.[key]?.length && <div class="chip-suggestions help">Seen recently: {props.context.suggestions[key]!.map((item) => <button type="button" class="chip suggestion" data-add-chip={item} disabled={disabled}>{item}</button>)}</div>}
      </div>
      {help}
    </>;
  } else if (s.type === 'array') {
    input = <><label for={id} class="field-label">{title}</label><textarea {...common}>{Array.isArray(value) ? value.join('\n') : ''}</textarea>{help}</>;
  } else if (s.secret) {
    input = <>
      <label for={id} class="field-label">{s.order && <span class="order-badge">{s.order}</span>}{title}</label>
      <div class="secret-control" data-secret>
        <input {...common} type="password" autocomplete="new-password" placeholder={value ? '••••••••••••••••' : 'Enter an API key'} data-secret-input readonly={!!value} />
        {!!value && <button type="button" class="btn secondary" data-replace-secret>Replace</button>}
      </div>
      {help}
    </>;
  } else {
    input = <>
      <label for={id} class="field-label">{title}</label>
      <input {...common} type={s.type === 'number' || s.type === 'integer' ? 'number' : 'text'} value={value === undefined ? '' : String(value)} min={s.minimum} max={s.maximum} step={s.type === 'integer' ? 1 : 'any'} placeholder={s.placeholder} data-template-input={s.widget === 'template' ? '' : undefined} />
      {help}
    </>;
  }
  return <div class={`field${disabled ? ' is-disabled' : ''}${s.type === 'boolean' || s.type === 'array' || s.widget === 'segmented' || s.secret ? ' field-wide' : ''}`} data-field={key} data-show-if={s.showIf ? JSON.stringify(s.showIf) : undefined} data-disabled-if={s.disabledIf ? JSON.stringify(s.disabledIf) : undefined} hidden={hidden}>{input}</div>;
}

function TemplateFields({ items, props }: { items: Field[]; props: FieldsProps }) {
  const tabs = [...new Set(items.map((field) => field.schema.templateTab ?? 'Template'))];
  return <div class="template-tabs" data-tabs>
    <div class="tabs" role="tablist" aria-label="Media templates">{tabs.map((tab, index) => <button type="button" class="tab" role="tab" id={`template-tab-${tab}`} aria-controls={`template-panel-${tab}`} aria-selected={index === 0 ? 'true' : 'false'} tabindex={index === 0 ? 0 : -1} data-tab={tab}><Icon name={tab === 'Movie' ? 'film' : tab === 'Track' ? 'music' : 'monitor'} size={15} />{tab}</button>)}</div>
    {tabs.map((tab, index) => {
      const entries = items.filter((field) => (field.schema.templateTab ?? 'Template') === tab);
      const variables = [...new Set(entries.flatMap((field) => field.schema.variables ?? []))];
      const previewUrl = props.previewUrl ? `${props.previewUrl}?kind=${encodeURIComponent(tab.toLowerCase())}` : undefined;
      return <div class="template-panel" role="tabpanel" id={`template-panel-${tab}`} aria-labelledby={`template-tab-${tab}`} data-tab-panel={tab} hidden={index !== 0} hx-post={previewUrl} hx-trigger={previewUrl ? 'load, input changed delay:350ms' : undefined} hx-include="closest form" hx-target="find .template-preview" hx-swap="innerHTML">
        <div class="form-grid">{entries.map((field) => <FieldInput field={field} props={props} />)}</div>
        <p class="help">Insert a variable. Text in [brackets] is dropped when a variable inside is empty.</p>
        <div class="variable-list">{variables.map((variable) => <button type="button" class="variable-button" data-insert-variable={`{${variable}}`}>{`{${variable}}`}</button>)}</div>
        {previewUrl && <div class="template-preview" aria-live="polite"><span class="muted small">Preview uses a current stream when one is available.</span></div>}
      </div>;
    })}
  </div>;
}

export function SettingsFields(props: FieldsProps) {
  const groups = new Map<string, { title: string; description?: string; fields: Field[] }>();
  for (const field of fields(props.schema)) {
    const group = field.schema.group;
    const title = typeof group === 'string' ? group : group?.title ?? 'Settings';
    if (!groups.has(title)) groups.set(title, { title, description: typeof group === 'object' ? group.description : undefined, fields: [] });
    groups.get(title)!.fields.push(field);
  }
  return <>{[...groups.values()].map((group) => <><section class="card flush settings-card">
    <div class="card-header"><div><h2>{group.title}</h2>{group.description && <p class="muted small">{group.description}</p>}</div></div>
    <div class="card-body">
      <div class="form-grid">{props.groupExtras?.[group.title]}{group.fields.filter((field) => field.schema.widget !== 'template').map((field) => <FieldInput field={field} props={props} />)}</div>
      {group.fields.some((field) => field.schema.widget === 'template') && <TemplateFields items={group.fields.filter((field) => field.schema.widget === 'template')} props={props} />}
    </div>
  </section>{props.afterGroups?.[group.title]}</>)}</>;
}

/** Convert submitted schema fields while preserving hidden and disabled dependent values. */
export function parseSettingsForm(schema: z.ZodObject, form: Record<string, unknown>, previous: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous };
  for (const { key, schema: s } of fields(schema)) {
    const name = `cfg.${key}`;
    const raw = form[name];
    const str = typeof raw === 'string' ? raw : undefined;
    if (s.type === 'boolean') {
      if (form[`${name}.__bool`] !== undefined) out[key] = raw === 'on';
    } else if (s.type === 'array' && s.items?.enum) {
      if (form[`${name}.__set`] !== undefined) out[key] = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
    } else if (s.type === 'array') {
      if (str !== undefined) out[key] = str.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } else if (s.type === 'number' || s.type === 'integer') {
      if (str !== undefined && str.trim() !== '') out[key] = Number(str);
    } else if (s.secret) {
      out[key] = str || previous[key];
    } else if (str !== undefined) out[key] = str;
  }
  const values = { ...out };
  for (const { key, schema: s } of fields(schema)) {
    if (matches(s.disabledIf, values) || (s.showIf && !matches(s.showIf, values))) out[key] = previous[key];
  }
  return out;
}

export function issuesByField(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    out[key] = out[key] ? `${out[key]}; ${issue.message}` : issue.message;
  }
  return out;
}
