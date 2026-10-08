/**
 * Tiny text templates for activity lines.
 *
 * - `{name}` is replaced by the variable's value (empty if missing).
 * - `[ ... ]` is an optional group: it's dropped entirely if any variable inside it is empty, and
 *   otherwise kept without the brackets. Groups don't nest.
 * - Separators (`·`, `-`, `|`, `,`) left dangling at either end are trimmed, so
 *   `[{genre}] · [Dir. {director}]` reads cleanly when either part is missing.
 *
 * Example: `S{season}E{episode}[ · {episodeTitle}]` → `S01E02 · Pilot`, or `S01E02` with no title.
 */

export type TemplateVars = Record<string, string | number | null | undefined>;

const VAR = /\{(\w+)\}/g;

function value(vars: TemplateVars, name: string): string {
  const v = vars[name];
  return v === null || v === undefined ? '' : String(v).trim();
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  const withGroups = template.replace(/\[([^[\]]*)\]/g, (_, inner: string) => {
    const names = [...inner.matchAll(VAR)].map((m) => m[1]!);
    if (names.some((n) => !value(vars, n))) return '';
    return inner;
  });
  return withGroups
    .replace(VAR, (_, name: string) => value(vars, name))
    .replace(/\s+/g, ' ')
    .replace(/^[\s·\-|,]+|[\s·\-|,]+$/g, '');
}

