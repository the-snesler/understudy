import { z } from 'zod';

/**
 * Renders a plugin's zod config schema as an HTML form and turns the submitted form back into raw
 * values for the schema to validate. It supports the field types plugins use: string, number,
 * boolean, enum, arrays of enums (checkboxes) and string arrays (one item per line). Mark API keys and the like with
 * `.meta({ secret: true })`: they render as password inputs and keep their value when left blank.
 */

interface FieldSchema {
  type?: string;
  enum?: unknown[];
  items?: FieldSchema;
  title?: string;
  description?: string;
  secret?: boolean;
  minimum?: number;
  maximum?: number;
}

interface Field {
  key: string;
  schema: FieldSchema;
}

function fields(schema: z.ZodObject): Field[] {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, FieldSchema>;
  };
  return Object.entries(json.properties ?? {}).map(([key, s]) => ({ key, schema: s }));
}

export function SettingsFields(props: {
  schema: z.ZodObject;
  values: Record<string, unknown>;
  errors?: Record<string, string>;
}) {
  return (
    <>
      {fields(props.schema).map(({ key, schema }) => {
        const value = props.values[key];
        const name = `cfg.${key}`;
        const title = schema.title ?? key;
        const help = schema.description && <div class="help">{schema.description}</div>;
        const error = props.errors?.[key] && <div class="help" style="color: var(--err)">{props.errors[key]}</div>;

        if (schema.type === 'boolean') {
          return (
            <label>
              <input type="hidden" name={`${name}.__bool`} value="1" />
              <input type="checkbox" name={name} checked={value === true} />
              {title}
              {help}
              {error}
            </label>
          );
        }
        if (schema.enum) {
          return (
            <label>
              {title}
              {help}
              <select name={name}>
                {schema.enum.map((opt) => (
                  <option value={String(opt)} selected={String(opt) === String(value)}>
                    {String(opt)}
                  </option>
                ))}
              </select>
              {error}
            </label>
          );
        }
        if (schema.type === 'array' && schema.items?.enum) {
          const selected = new Set((Array.isArray(value) ? value : []).map(String));
          return (
            <fieldset style="border: 0; padding: 0; margin: .9rem 0 0">
              <legend style="font-weight: 600; padding: 0">{title}</legend>
              {help}
              <input type="hidden" name={`${name}.__set`} value="1" />
              {schema.items.enum.map((opt) => (
                <label style="display: inline-block; font-weight: 400; margin: 0 1rem 0 0">
                  <input type="checkbox" name={name} value={String(opt)} checked={selected.has(String(opt))} />
                  {String(opt)}
                </label>
              ))}
              {error}
            </fieldset>
          );
        }
        if (schema.type === 'array') {
          return (
            <label>
              {title}
              {help}
              <textarea name={name}>{Array.isArray(value) ? value.join('\n') : ''}</textarea>
              {error}
            </label>
          );
        }
        if (schema.type === 'number' || schema.type === 'integer') {
          return (
            <label>
              {title}
              {help}
              <input
                type="number"
                name={name}
                value={value === undefined ? '' : String(value)}
                min={schema.minimum}
                max={schema.maximum}
                step={schema.type === 'integer' ? 1 : 'any'}
              />
              {error}
            </label>
          );
        }
        if (schema.secret) {
          return (
            <label>
              {title}
              {help}
              <input
                type="password"
                name={name}
                autocomplete="off"
                placeholder={value ? '(unchanged; type to replace)' : ''}
              />
              {error}
            </label>
          );
        }
        return (
          <label>
            {title}
            {help}
            <input type="text" name={name} value={value === undefined ? '' : String(value)} />
            {error}
          </label>
        );
      })}
    </>
  );
}

/** Convert a submitted form (fields named `cfg.<key>`) to raw config values. */
export function parseSettingsForm(
  schema: z.ZodObject,
  form: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, schema: s } of fields(schema)) {
    const name = `cfg.${key}`;
    const raw = form[name];
    const str = typeof raw === 'string' ? raw : undefined;
    if (s.type === 'boolean') {
      if (form[`${name}.__bool`] !== undefined) out[key] = raw === 'on';
    } else if (s.type === 'array' && s.items?.enum) {
      if (form[`${name}.__set`] !== undefined) out[key] = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
    } else if (s.type === 'array') {
      if (str !== undefined) out[key] = str.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } else if (s.type === 'number' || s.type === 'integer') {
      if (str !== undefined && str.trim() !== '') out[key] = Number(str);
    } else if (s.secret) {
      out[key] = str ? str : previous[key];
    } else if (str !== undefined) {
      out[key] = str;
    }
  }
  return out;
}

/** Map validation issues to the top-level field they belong to. */
export function issuesByField(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    out[key] = out[key] ? `${out[key]}; ${issue.message}` : issue.message;
  }
  return out;
}
