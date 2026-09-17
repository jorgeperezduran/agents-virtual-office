/**
 * Tiny, logic-free templating for crew files. No eval, no code from a crew file ever runs.
 *   {{ticket.key}}            value at a path
 *   {{cases.cases|titles}}    bullet list of the main text of each item
 *   {{plan|json}}             pretty JSON
 *   {{run.failures|count}}    length
 * Paths may map over arrays: "regression.suites[].file".
 */
const MAIN_KEYS = ['title', 'summary', 'name', 'file', 'key', 'text'];

export function pick(ctx, p) {
  const parts = String(p).trim().split('.').filter(Boolean);
  let cur = [ctx], mapped = false;
  for (let part of parts) {
    const each = part.endsWith('[]');
    if (each) part = part.slice(0, -2);
    cur = cur.map(v => (v != null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, part) ? v[part] : undefined));
    if (each) { mapped = true; cur = cur.flatMap(v => (Array.isArray(v) ? v : v == null ? [] : [v])); }
  }
  return mapped ? cur.filter(v => v !== undefined) : cur[0];
}

export const mainText = item => {
  if (item == null) return '';
  if (typeof item !== 'object') return String(item);
  const k = MAIN_KEYS.find(k => typeof item[k] === 'string' && item[k]);
  return k ? item[k] : JSON.stringify(item);
};

function format(v, filter) {
  if (filter === 'json') return JSON.stringify(v ?? null, null, 1);
  if (filter === 'count') return String(Array.isArray(v) ? v.length : v == null ? 0 : 1);
  if (filter === 'titles') return (Array.isArray(v) ? v : v == null ? [] : [v]).map(x => '- ' + mainText(x)).join('\n');
  if (filter === 'numbered') return (Array.isArray(v) ? v : v == null ? [] : [v]).map((x, i) => `${i + 1}. ${mainText(x)}`).join('\n');
  if (v == null) return '';
  if (Array.isArray(v)) return v.every(x => typeof x !== 'object') ? v.map(x => '- ' + x).join('\n') : JSON.stringify(v, null, 1);
  if (typeof v === 'object') return JSON.stringify(v, null, 1);
  return String(v);
}

export function render(tpl, ctx) {
  return String(tpl ?? '').replace(/\{\{\s*([^}|]+?)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (_, p, filter) => format(pick(ctx, p), filter));
}

/** { path, op, value } conditions for branch steps. */
export function test(when, ctx) {
  const v = pick(ctx, when.path);
  const n = Array.isArray(v) ? v.length : v;
  switch (when.op || 'truthy') {
    case 'truthy': return Array.isArray(v) ? v.length > 0 : !!v;
    case 'falsy': return Array.isArray(v) ? v.length === 0 : !v;
    case 'eq': return v === when.value;
    case 'ne': return v !== when.value;
    case 'gt': return Number(n) > Number(when.value);
    case 'lt': return Number(n) < Number(when.value);
    default: return false;
  }
}
