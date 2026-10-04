/**
 * Lenient, deterministic task-file front end (no model involved):
 *
 *   decoded data -> provider-key scan -> alias tables -> inference -> canonical candidate
 *
 * Everything renamed, inferred, dropped or carried becomes a warning; what must stay an error
 * (provider keys, contradictory kind, nameless resources, ...) becomes an error. task.ts then
 * validates the candidate with the strict canonical schema, so this front end widens what a task
 * file may LOOK like, never what a valid task IS. Nothing is silently dropped: keys the harness
 * has no slot for are carried to the model verbatim.
 */
import { basename } from 'node:path';
import pluralize from 'pluralize';
import type { FieldType, Operation, TaskKind } from './types.ts';

type Obj = Record<string, unknown>;

export interface NormalizeOptions {
  /** Task file path: its basename is the first source of a missing id. */
  file: string;
  /** `--target` / `--output` overrides: they win over the file and decide a missing kind. */
  target?: string | undefined;
  output?: string | undefined;
}

export interface Normalized {
  /** The task in the canonical shape, still to be validated by the canonical schema. */
  candidate: Obj;
  warnings: string[];
  errors: string[];
}

/** Keys compare case-, dash-, underscore-, dot- and space-insensitively. */
export function normKey(k: string): string {
  return k.toLowerCase().replace(/[-_\s.]/g, '');
}

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ───────────────────────────── provider keys ─────────────────────────────

/** Keys that only ever select or tune a model. `model`/`models` may also name data models (see resourceLike). */
const PROVIDER_ONLY = new Set(['provider', 'providers', 'driver', 'drivers', 'llm', 'llms', 'temperature', 'modelname', 'modelid', 'modelprovider']);
const MODEL_KEYS = new Set(['model', 'models']);
/** Settings-like containers whose direct keys are scanned too (resources and fields never are). */
const PROVIDER_CONTAINERS = new Set(['limits', 'options', 'settings', 'config', 'configuration', 'harness', 'agent', 'runtime', 'run', 'execution']);
const NEUTRAL_HINT = 'task files are provider-neutral (choose the model with --driver/--model)';

const FIELDS_KEYS = ['fields', 'properties', 'attributes', 'columns', 'schema', 'props', 'attrs', 'shape'];

/** A value that describes data models (a list of objects, a map of specs, or a spec with fields), not a model id. */
function resourceLike(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0 && v.every(isObj);
  if (!isObj(v)) return false;
  if (Object.keys(v).some((k) => FIELDS_KEYS.includes(normKey(k)))) return true;
  const values = Object.values(v);
  return values.length > 0 && values.every((x) => isObj(x) || Array.isArray(x));
}

function isProviderKey(key: string, value: unknown): boolean {
  const n = normKey(key);
  if (MODEL_KEYS.has(n)) return !resourceLike(value);
  return PROVIDER_ONLY.has(n) || n.endsWith('apikey');
}

/** Provider/model keys at the top level and directly inside settings-like containers. */
export function providerKeyErrors(data: Obj): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (isProviderKey(k, v)) out.push(`(root): key "${k}" is not allowed: ${NEUTRAL_HINT}`);
    else if (PROVIDER_CONTAINERS.has(normKey(k)) && isObj(v)) {
      for (const [ik, iv] of Object.entries(v)) {
        if (isProviderKey(ik, iv)) out.push(`${k}: key "${ik}" is not allowed: ${NEUTRAL_HINT}`);
      }
    }
  }
  return out;
}

/** `data` without the keys providerKeyErrors reports (so the canonical schema does not report them twice). */
export function withoutProviderKeys(data: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(data)) {
    if (isProviderKey(k, v)) continue;
    if (PROVIDER_CONTAINERS.has(normKey(k)) && isObj(v)) {
      out[k] = Object.fromEntries(Object.entries(v).filter(([ik, iv]) => !isProviderKey(ik, iv)));
    } else out[k] = v;
  }
  return out;
}

// ───────────────────────────── alias tables ─────────────────────────────
// Normalized key forms (normKey); the canonical name comes first.

const TOP = {
  kind: ['kind', 'type', 'mode', 'tasktype', 'taskkind'],
  id: ['id', 'slug', 'taskid', 'identifier'],
  title: ['title', 'name', 'summary', 'taskname', 'heading'],
  output: ['output', 'outdir', 'out', 'outputdir', 'outputdirectory', 'destination', 'dest'],
  /** Always an existing API to change. */
  targetStrong: ['target', 'targetdir', 'repo', 'repository', 'codebase', 'apiroot', 'existingapi'],
  /** An existing API only when the value looks like a path (or the kind is brownfield). */
  targetWeak: ['path', 'api', 'root', 'project', 'dir', 'directory', 'source'],
  change: ['change', 'changes', 'changerequest'],
  brief: ['brief', 'description', 'desc', 'prompt', 'task', 'request', 'goal', 'goals', 'overview', 'details', 'spec', 'specification', 'instructions', 'context', 'body', 'text', 'story', 'userstory', 'objective'],
  behaviours: ['behaviours', 'behaviors', 'behaviour', 'behavior', 'acceptance', 'acceptancecriteria', 'acceptancetests', 'criteria', 'requirements', 'rules', 'scenarios', 'tests', 'testcases', 'userstories', 'stories', 'features', 'businessrules', 'constraints'],
  resources: ['resources', 'resource', 'entities', 'entity', 'models', 'model', 'objects', 'collections', 'tables', 'schemas', 'datamodel', 'datamodels', 'domain'],
  endpoints: ['endpoints', 'routes', 'paths', 'apiendpoints'],
  operations: ['operations', 'ops', 'actions', 'crud'],
  template: ['template', 'scaffold'],
  basePath: ['basepath', 'prefix', 'apiprefix', 'baseurl', 'urlprefix', 'routeprefix'],
  scope: ['scope'],
  allowBreaking: ['allowbreaking', 'allowbreakingchanges', 'breakingchanges', 'breaking'],
  /** Brownfield standards policy: strict (default, 100% over the whole API) or the explicit baseline opt-in. */
  standards: ['standards', 'standardsmode', 'standardspolicy', 'standardsgate'],
  limits: ['limits'],
};

const RES = {
  name: ['name', 'resource', 'entity', 'singular', 'title'],
  plural: ['plural', 'pluralname'],
  fields: FIELDS_KEYS,
  operations: ['operations', 'ops', 'actions', 'methods', 'crud', 'verbs'],
  endpoints: ['endpoints', 'routes', 'paths', 'apiendpoints'],
  notes: ['description', 'desc', 'notes', 'note', 'doc', 'docs', 'comment', 'summary', 'about'],
};
const RES_STRUCTURAL = [...RES.plural, ...RES.fields, ...RES.operations, ...RES.endpoints];

const TYPE_ALIASES: Record<string, FieldType> = {
  string: 'string', str: 'string', text: 'string', varchar: 'string', char: 'string', character: 'string', longtext: 'string', citext: 'string', nvarchar: 'string',
  email: 'email', emailaddress: 'email',
  uuid: 'uuid', guid: 'uuid',
  integer: 'integer', int: 'integer', int8: 'integer', int16: 'integer', int32: 'integer', int64: 'integer', long: 'integer', bigint: 'integer', smallint: 'integer', tinyint: 'integer', serial: 'integer', bigserial: 'integer', uint: 'integer',
  number: 'number', float: 'number', double: 'number', real: 'number', float32: 'number', float64: 'number',
  decimal: 'decimal', numeric: 'decimal', money: 'decimal', currency: 'decimal', bigdecimal: 'decimal',
  boolean: 'boolean', bool: 'boolean',
  datetime: 'datetime', timestamp: 'datetime', timestamptz: 'datetime', instant: 'datetime', isodatetime: 'datetime',
  date: 'date', localdate: 'date', isodate: 'date',
  time: 'time', localtime: 'time',
  enum: 'enum', enumeration: 'enum',
  array: 'array', list: 'array',
  object: 'object', json: 'object', jsonb: 'object', map: 'object', dict: 'object', dictionary: 'object', record: 'object', hash: 'object', struct: 'object',
};

/** `format:` values that name a canonical type. */
const FORMAT_TYPES: Record<string, FieldType> = {
  email: 'email', uuid: 'uuid', datetime: 'datetime', date: 'date', time: 'time',
  int32: 'integer', int64: 'integer', float: 'number', double: 'number', decimal: 'decimal',
};

const ALL_OPS: Operation[] = ['list', 'get', 'create', 'update', 'delete'];
const OP_ALIASES: Record<string, Operation[]> = {
  list: ['list'], index: ['list'], search: ['list'], query: ['list'], browse: ['list'], findall: ['list'], getall: ['list'], listall: ['list'],
  get: ['get'], show: ['get'], retrieve: ['get'], fetch: ['get'], view: ['get'], find: ['get'], findone: ['get'], getone: ['get'], detail: ['get'], details: ['get'],
  read: ['list', 'get'], readonly: ['list', 'get'],
  create: ['create'], add: ['create'], post: ['create'], new: ['create'], insert: ['create'],
  update: ['update'], edit: ['update'], patch: ['update'], put: ['update'], modify: ['update'], replace: ['update'], upsert: ['update'],
  delete: ['delete'], remove: ['delete'], destroy: ['delete'], del: ['delete'], erase: ['delete'],
  crud: ALL_OPS, all: ALL_OPS, full: ALL_OPS, everything: ALL_OPS,
};

const SERVER_MANAGED = new Set(['id', 'createdat', 'updatedat']);

// ───────────────────────────── small helpers ─────────────────────────────

/** Entries of `o` whose key is one of `aliases`, in alias-priority order (file order on ties); marks them used. */
function pick(o: Obj, aliases: readonly string[], used: Set<string>, accept: (v: unknown) => boolean = () => true): Array<[string, unknown]> {
  const hits: Array<[string, unknown, number]> = [];
  for (const [k, v] of Object.entries(o)) {
    if (used.has(k)) continue;
    const i = aliases.indexOf(normKey(k));
    if (i !== -1 && accept(v)) hits.push([k, v, i]);
  }
  hits.sort((a, b) => a[2] - b[2]);
  for (const [k] of hits) used.add(k);
  return hits.map(([k, v]) => [k, v]);
}

/** The highest-priority entry for `aliases`; the others stay unused (and are carried). */
function pickOne(o: Obj, aliases: readonly string[], used: Set<string>, accept: (v: unknown) => boolean = () => true): [string, unknown] | undefined {
  const hits = pick(o, aliases, new Set(used), accept);
  const first = hits[0];
  if (first !== undefined) used.add(first[0]);
  return first;
}

function isScalar(v: unknown): v is string | number | boolean {
  return (typeof v === 'string' && v.trim() !== '') || typeof v === 'number' || typeof v === 'boolean';
}

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** One line for a structured value: `k: v; k: v` for maps, JSON for anything nested deeper. */
function inline(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(inline).join(', ');
  return Object.entries(v)
    .map(([k, x]) => `${k}: ${typeof x === 'object' && x !== null ? JSON.stringify(x) : inline(x)}`)
    .join('; ');
}

const BULLET = /^([-*•+]|\d+[.)])\s+/;

/** List-like values: a list, a bulleted string (one item per bullet), or a map (`key: value` lines). */
function items(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.flatMap((x) => (Array.isArray(x) ? items(x) : [inline(x)])).filter((s) => s.length > 0);
  if (typeof v === 'string') {
    const lines = v.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (!lines.some((l) => BULLET.test(l))) return v.trim() === '' ? [] : [v.trim()];
    const out: string[] = [];
    for (const l of lines) {
      const last = out.length - 1;
      if (BULLET.test(l) || last < 0) out.push(l.replace(BULLET, ''));
      else out[last] = `${out[last] ?? ''} ${l}`; // continuation of the previous bullet
    }
    return out;
  }
  if (isObj(v)) {
    return Object.entries(v).flatMap(([k, x]) => (Array.isArray(x) ? x.map((y) => `${k}: ${inline(y)}`) : [`${k}: ${inline(x)}`]));
  }
  return [String(v)];
}

/** Free text from any value (lists become bullets, maps `key: value` lines). */
function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() === '' ? undefined : v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const xs = items(v);
    return xs.length > 0 ? xs.map((x) => `- ${x}`).join('\n') : undefined;
  }
  if (isObj(v)) {
    const xs = items(v);
    return xs.length > 0 ? xs.join('\n') : undefined;
  }
  return undefined;
}

export function slugify(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/**
 * The kind a value names. Change words win ("new feature on the existing API" is a change). An alias
 * key (`type`, `mode`) only counts for a short phrase, so `type: REST API built with new tooling` is not a kind.
 */
function kindValue(v: unknown, alias = false): TaskKind | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (alias && s.split(/\s+/).length > 3) return undefined;
  if (/\b(brown\w*|changes?|modify|existing|update|edit|extend|enhance|feature|patch)\b/.test(s)) return 'brownfield';
  if (/\b(green\w*|new|create|scaffold|build|from[-_ ]?scratch)\b/.test(s)) return 'greenfield';
  return undefined;
}

function pathLike(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return s !== '' && !/\s/.test(s) && (/[\\/]/.test(s) || s.startsWith('.'));
}

function cleanPath(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s === '' ? '.' : s;
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** First markdown heading, else the first sentence (at most 80 characters, cut at a word). */
function titleFrom(text: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  const first = heading !== undefined ? heading.replace(/^#+\s+/, '') : (lines[0] ?? '').replace(BULLET, '');
  const sentence = (first.split(/(?<=[.!?])\s/)[0] ?? first).replace(/[.!?:;,]+$/, '').replace(/\s+/g, ' ').trim();
  if (sentence === '') return undefined;
  if (sentence.length <= 80) return sentence;
  const cut = sentence.slice(0, 80);
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : cut).replace(/[.!?:;,]+$/, '');
}

function boolOf(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 1) return true;
  if (v === 0) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (/^(true|yes|y|1|on|required)$/.test(s)) return true;
    if (/^(false|no|n|0|off|optional)$/.test(s)) return false;
  }
  return undefined;
}

/** Brownfield standards policy value -> 'strict' | 'baseline'; anything else is left for the schema to reject. */
const STANDARDS_MODES: Record<string, 'strict' | 'baseline'> = {
  strict: 'strict', full: 'strict', whole: 'strict', wholeapi: 'strict', '100': 'strict', all: 'strict',
  baseline: 'baseline', diff: 'baseline', diffaware: 'baseline', noregression: 'baseline', nonregression: 'baseline', lenient: 'baseline',
};

function standardsModeOf(v: unknown, warn: (m: string) => void): unknown {
  if (typeof v !== 'string') return v;
  const mode = STANDARDS_MODES[v.trim().toLowerCase().replace(/[^a-z0-9]/g, '')];
  if (mode === undefined) return v;
  if (mode !== v) warn(`standards "${v}" -> "${mode}"`);
  return mode;
}

function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return undefined;
}

function unquote(s: string): string {
  const t = s.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

function valuesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => isScalar(x)).map((x) => unquote(String(x))).filter((x) => x.length > 0);
  if (typeof v === 'string') return v.split(/\s*[|,]\s*/).map(unquote).filter((x) => x.length > 0);
  if (isObj(v)) return Object.keys(v);
  return [];
}

// ───────────────────────────── fields ─────────────────────────────

interface FieldDraft {
  type?: FieldType;
  rawType?: string;
  required?: boolean;
  unique?: boolean;
  readOnly?: boolean;
  values?: string[];
  min?: number;
  max?: number;
  default?: unknown;
  itemType?: string;
  notes: string[];
}

/** Canonical type of a declared type; the declaration is kept as rawType whenever it is not the canonical name. */
export function resolveType(declared: string): { type: FieldType; rawType?: string } {
  const d = declared.trim();
  const canon = TYPE_ALIASES[normKey(d)];
  if (canon !== undefined) return normKey(d) === canon ? { type: canon } : { type: canon, rawType: d };
  if (/^.+\[\]$/.test(d) || /^\[.+\]$/.test(d) || /^(array|list|set|collection)\s*(<.+>|\(.+\)|\s+of\s+.+)$/i.test(d)) return { type: 'array', rawType: d };
  return { type: 'unknown', rawType: d };
}

function isKnownType(token: string): boolean {
  return !/\s/.test(token.trim()) || /^(array|list|set|collection)\s+of\s+\S+$/i.test(token.trim())
    ? resolveType(token).type !== 'unknown'
    : false;
}

function setType(d: FieldDraft, declared: string): void {
  const r = resolveType(declared);
  d.type = r.type;
  if (r.rawType !== undefined) d.rawType = r.rawType;
  else delete d.rawType;
}

/** Consume one flag/bound/default/values/type token; false when it means nothing to the grammar. */
function applyToken(tok: string, d: FieldDraft): boolean {
  const t = tok.trim();
  const lower = t.toLowerCase();
  let m: RegExpMatchArray | null;
  if (/^(required|req|mandatory|not ?null)$/.test(lower)) d.required = true;
  else if (lower === 'optional') d.required = false;
  else if (lower === 'nullable') d.notes.push('nullable');
  else if (lower === 'unique') d.unique = true;
  else if (/^read[- ]?only$/.test(lower)) d.readOnly = true;
  else if (/^(pk|primary|primary ?key)$/.test(lower)) d.notes.push('primary key');
  else if ((m = lower.match(/^(min|minimum|minlength|max|maximum|maxlength)\s*[:= ]\s*(-?\d+(?:\.\d+)?)$/)) !== null) {
    if ((m[1] ?? '').startsWith('min')) d.min = Number(m[2]);
    else d.max = Number(m[2]);
  } else if ((m = lower.match(/^(>=|<=)\s*(-?\d+(?:\.\d+)?)$/)) !== null) {
    if (m[1] === '>=') d.min = Number(m[2]);
    else d.max = Number(m[2]);
  } else if ((m = lower.match(/^(-?\d+(?:\.\d+)?)\s*(?:\.\.|to)\s*(-?\d+(?:\.\d+)?)$/)) !== null) {
    d.min = Number(m[1]);
    d.max = Number(m[2]);
  } else if ((m = t.match(/^default\s*[:= ]\s*(.+)$/i)) !== null) d.default = unquote(m[1] ?? '');
  else if (/^[^|\s]+(\s*\|\s*[^|\s]+)+$/.test(t)) {
    // `string|null` is a union of types; `pending|paid` is a list of values
    const parts = valuesOf(t);
    const types = parts.filter((x) => x.toLowerCase() !== 'null');
    if (d.type === undefined && types.length > 0 && types.every(isKnownType)) {
      setType(d, types[0] ?? t);
      if (types.length > 1 || parts.length > types.length) d.rawType = t;
      if (parts.length > types.length) d.notes.push('nullable');
    } else d.values = parts;
  } else if (d.type === undefined && isKnownType(t)) setType(d, t);
  else return false;
  return true;
}

/** Field string grammar: `type, flags, min N, max N, default X, enum(a|b)`; unknown words become description. */
function applyFieldString(spec: string, d: FieldDraft): void {
  let s = spec.trim();
  s = s.replace(/\b(?:enum|one\s*of|oneof|values)\s*[:=]?\s*[([{]\s*([^)\]}]*)[)\]}]/gi, (_m, inner: string) => {
    d.values = valuesOf(inner);
    return ',';
  });
  s = s.replace(/\b([A-Za-z]+)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g, (_m, t: string, a: string, b: string) => {
    d.notes.push(`precision ${a},${b}`);
    return t;
  });
  s = s.replace(/\b([A-Za-z]+)\s*\(\s*(\d+)\s*\)/g, (_m, t: string, n: string) => `${t}, max ${n}`);
  for (const tok of s.split(/[,;()]/).map((x) => x.trim()).filter((x) => x.length > 0)) {
    if (applyToken(tok, d)) continue;
    const words = tok.split(/\s+/);
    if (words.length === 1) {
      if (d.type === undefined) setType(d, tok);
      else d.notes.push(tok);
      continue;
    }
    // Several words: consume what the grammar knows, keep the rest as a description phrase.
    let phrase: string[] = [];
    const flush = (): void => {
      if (phrase.length > 0) d.notes.push(phrase.join(' '));
      phrase = [];
    };
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i] ?? '';
      const next = words[i + 1];
      const pair = next !== undefined ? `${w} ${next}` : undefined;
      if (pair !== undefined && /^(min|max|minimum|maximum|default|read only|primary key|not null|minlength|maxlength)\b/i.test(pair) && applyToken(pair, d)) {
        flush();
        i += 1;
      } else if (applyToken(w, d)) flush();
      else phrase.push(w);
    }
    flush();
  }
}

const F = {
  name: ['name', 'field', 'fieldname', 'key'],
  type: ['type', 'datatype', 'fieldtype'],
  format: ['format'],
  items: ['items', 'itemtype', 'of', 'elementtype', 'arrayof', 'itemsof'],
  required: ['required', 'mandatory', 'isrequired'],
  optional: ['optional'],
  nullable: ['nullable', 'null', 'allownull'],
  unique: ['unique', 'isunique'],
  readOnly: ['readonly', 'isreadonly', 'servermanaged', 'generated', 'computed'],
  min: ['min', 'minimum', 'minlength', 'minitems', 'minvalue', 'gte', 'ge', 'minlen'],
  max: ['max', 'maximum', 'maxlength', 'maxitems', 'maxvalue', 'lte', 'le', 'maxlen', 'length', 'size'],
  values: ['values', 'enum', 'options', 'choices', 'oneof', 'allowed', 'allowedvalues', 'in', 'enumvalues'],
  default: ['default', 'defaultvalue', 'defaults'],
  description: ['description', 'desc', 'doc', 'docs', 'notes', 'note', 'comment', 'comments', 'help', 'label'],
};

function applyFieldObject(spec: Obj, d: FieldDraft, where: string, warn: (s: string) => void): void {
  for (const [k, v] of Object.entries(spec)) {
    const n = normKey(k);
    if (F.name.includes(n)) continue;
    if (F.type.includes(n)) {
      if (typeof v === 'string' && v.trim() !== '') setType(d, v);
      else if (Array.isArray(v)) {
        const named = v.filter((x): x is string => typeof x === 'string');
        const real = named.filter((x) => x.toLowerCase() !== 'null');
        if (real[0] !== undefined) setType(d, real[0]);
        if (real.length > 1) d.rawType = real.join(' | ');
        if (real.length < named.length) d.notes.push('nullable');
      } else d.notes.push(`type: ${inline(v)}`);
    } else if (F.format.includes(n)) {
      const t = typeof v === 'string' ? FORMAT_TYPES[normKey(v)] : undefined;
      if (t !== undefined && !['integer', 'number', 'decimal'].includes(t)) {
        d.type = t;
        delete d.rawType;
      } else if (t !== undefined && (d.type === undefined || ['number', 'integer', 'decimal'].includes(d.type))) {
        d.type = t;
        if (typeof v === 'string') d.rawType = v;
      } else d.notes.push(`format: ${inline(v)}`);
    } else if (F.items.includes(n)) d.itemType = isObj(v) ? inline(v.type ?? v) : inline(v);
    else if (F.required.includes(n) || F.unique.includes(n) || F.readOnly.includes(n) || F.optional.includes(n)) {
      const b = boolOf(v);
      if (b === undefined) {
        d.notes.push(`${k}: ${inline(v)}`);
        warn(`${where}: "${k}: ${inline(v)}" is not a yes/no value; kept in the description`);
      } else if (F.required.includes(n)) d.required = b;
      else if (F.optional.includes(n)) d.required = !b;
      else if (F.unique.includes(n)) d.unique = b;
      else d.readOnly = b;
    } else if (F.nullable.includes(n)) {
      if (boolOf(v) === true) d.notes.push('nullable');
    } else if (F.min.includes(n) || F.max.includes(n)) {
      const num = numberOf(v);
      if (num === undefined) {
        d.notes.push(`${k}: ${inline(v)}`);
        warn(`${where}: "${k}: ${inline(v)}" is not a number; kept in the description`);
      } else if (F.min.includes(n)) d.min = num;
      else if (n === 'length' || n === 'size') {
        d.min = num;
        d.max = num;
      } else d.max = num;
    } else if (F.values.includes(n)) d.values = valuesOf(v);
    else if (F.default.includes(n)) d.default = v;
    else if (F.description.includes(n)) d.notes.unshift(inline(v));
    else {
      d.notes.push(`${k}: ${inline(v)}`);
      warn(`${where}: "${k}" kept in the field description`);
    }
  }
}

/** A field name as an identifier: `first name` / `first-name` -> `firstName`. */
function fieldName(raw: string): string {
  const t = raw.trim();
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(t)) return t;
  const words = t.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

/** A value that reads as one field's spec (a type string, a spec object, a list of enum values, or nothing). */
function fieldLike(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v === 'string') {
    const segment = (v.trim().split(/[,;(]/)[0] ?? '').trim();
    const first = segment.split(/\s+/)[0] ?? '';
    if (first === '') return false;
    if (isKnownType(first) || /^(required|optional|unique|enum)$/i.test(first)) return true;
    if (/^[^|\s]+(\s*\|\s*[^|\s]+)+$/.test(segment)) return true; // enum shorthand `a|b`
    // a lone capitalised word is a type reference (`customer: Customer`, `items: OrderItem[]`)
    return segment === first && /^[A-Z][A-Za-z0-9]*(\[\])?$/.test(first);
  }
  if (isObj(v)) return Object.keys(v).some((k) => [...F.type, ...F.format, ...F.values, ...F.required].includes(normKey(k)));
  if (Array.isArray(v)) return v.length > 0 && v.every((x) => isScalar(x));
  return false;
}

function field(rawName: string, spec: unknown, where: string, warn: (s: string) => void): Obj | null {
  const name = fieldName(rawName);
  if (name !== rawName.trim()) warn(`${where}: field "${rawName}" -> "${name}"`);
  const at = `${where}.${name}`;
  if (SERVER_MANAGED.has(normKey(name))) {
    warn(`${at}: dropped; id, createdAt and updatedAt are server-managed and implied for every resource`);
    return null;
  }
  const d: FieldDraft = { notes: [] };
  if (typeof spec === 'string') applyFieldString(spec, d);
  else if (isObj(spec)) applyFieldObject(spec, d, at, warn);
  else if (Array.isArray(spec)) d.values = valuesOf(spec);
  else if (spec !== null && spec !== undefined) d.notes.push(inline(spec));

  if (d.itemType !== undefined && (d.type === undefined || d.type === 'array')) {
    d.type = 'array';
    d.rawType ??= `${d.itemType}[]`;
  } else if (d.itemType !== undefined) d.notes.push(`items: ${d.itemType}`);
  if (d.values !== undefined) {
    if (d.type === undefined || d.type === 'string' || d.type === 'unknown' || d.type === 'enum') {
      d.type = 'enum';
      delete d.rawType;
    } else {
      d.notes.push(`one of ${d.values.join('|')}`);
      warn(`${at}: values on a ${d.rawType ?? d.type} field kept in the description`);
      delete d.values;
    }
  }
  if (d.type === undefined) {
    d.type = 'unknown';
    warn(`${at}: no type given; the brief says "unspecified type"`);
  }
  let dflt: string | number | boolean | undefined;
  if (d.default !== undefined) {
    const v = d.default;
    if (typeof v === 'string' && ['integer', 'number', 'decimal'].includes(d.type) && numberOf(v) !== undefined) dflt = numberOf(v);
    else if (typeof v === 'string' && d.type === 'boolean' && boolOf(v) !== undefined) dflt = boolOf(v);
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') dflt = v;
    else {
      d.notes.push(`default: ${JSON.stringify(v)}`);
      warn(`${at}: structured default kept in the description`);
    }
  }
  return {
    name,
    type: d.type,
    ...(d.rawType !== undefined ? { rawType: d.rawType } : {}),
    required: d.required ?? false,
    unique: d.unique ?? false,
    readOnly: d.readOnly ?? false,
    ...(d.values !== undefined ? { values: d.values } : {}),
    ...(d.min !== undefined ? { min: d.min } : {}),
    ...(d.max !== undefined ? { max: d.max } : {}),
    ...(dflt !== undefined ? { default: dflt } : {}),
    ...(d.notes.length > 0 ? { description: d.notes.join('; ') } : {}),
  };
}

/** `name: spec`, `name (spec)`, `name spec…` or a bare name. */
function splitFieldLine(line: string): [string, string] {
  const s = line.trim();
  const colon = s.indexOf(':');
  if (colon > 0) return [s.slice(0, colon), s.slice(colon + 1)];
  const m = s.match(/^([A-Za-z_][\w-]*)\s*(?:\((.*)\)|\s+(.*))?$/);
  if (m !== null) return [m[1] ?? s, m[2] ?? m[3] ?? ''];
  return [s, ''];
}

function fieldsOf(raw: unknown, where: string, warn: (s: string) => void, err: (s: string) => void): Obj[] {
  const entries: Array<[string, unknown]> = [];
  if (Array.isArray(raw)) {
    raw.forEach((it, i) => {
      if (typeof it === 'string') {
        const [n, spec] = splitFieldLine(it);
        entries.push([n, spec === '' ? null : spec]);
      } else if (isObj(it)) {
        const nameKey = Object.keys(it).find((k) => F.name.includes(normKey(k)) && isScalar(it[k]));
        if (nameKey !== undefined) entries.push([String(it[nameKey]), it]);
        else if (Object.keys(it).length === 1) {
          const [k, v] = Object.entries(it)[0] ?? ['', null];
          entries.push([k, v]);
        } else err(`${where}.${i}: field has no name (${inline(it).slice(0, 60)})`);
      } else err(`${where}.${i}: cannot read a field from ${JSON.stringify(it)}`);
    });
  } else if (isObj(raw)) {
    entries.push(...Object.entries(raw));
  } else if (typeof raw === 'string') {
    const lines = raw.split('\n').map((l) => l.trim().replace(BULLET, '')).filter((l) => l.length > 0);
    const parts = lines.length > 1 ? lines : raw.includes(';') ? raw.split(';') : raw.includes(':') ? raw.split(/,(?=\s*[A-Za-z_][\w -]*:)/) : raw.split(',');
    for (const p of parts.map((x) => x.trim()).filter((x) => x.length > 0)) {
      const [n, spec] = splitFieldLine(p);
      entries.push([n, spec === '' ? null : spec]);
    }
  } else if (raw !== null && raw !== undefined) err(`${where}: cannot read fields from ${JSON.stringify(raw)}`);
  const out: Obj[] = [];
  for (const [n, spec] of entries) {
    if (n.trim() === '') {
      err(`${where}: a field has an empty name`);
      continue;
    }
    const f = field(n, spec, where, warn);
    if (f !== null) out.push(f);
  }
  return out;
}

// ───────────────────────────── operations & endpoints ─────────────────────────────

interface Endpoint {
  method?: string;
  path?: string;
  text: string;
}

const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s*(.*)$/i;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

function endpoint(text: string, extra?: string): Endpoint {
  const m = text.trim().match(METHOD);
  const full = extra !== undefined && extra !== '' ? `${text.trim()} - ${extra}` : text.trim();
  return m === null ? { text: full } : { method: (m[1] ?? '').toUpperCase(), path: m[2] ?? '', text: full };
}

function endpointsOf(v: unknown): Endpoint[] {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string') return items(v).map((x) => endpoint(x));
  if (Array.isArray(v)) {
    return v.flatMap((x): Endpoint[] => {
      if (typeof x === 'string') return [endpoint(x)];
      if (isObj(x)) {
        const method = Object.entries(x).find(([k]) => ['method', 'verb', 'httpmethod'].includes(normKey(k)))?.[1];
        const path = Object.entries(x).find(([k]) => ['path', 'url', 'route', 'uri'].includes(normKey(k)))?.[1];
        if (typeof method === 'string' && typeof path === 'string') {
          const rest = Object.entries(x).filter(([k]) => !['method', 'verb', 'httpmethod', 'path', 'url', 'route', 'uri'].includes(normKey(k)));
          return [endpoint(`${method} ${path}`, inline(Object.fromEntries(rest)))];
        }
        return endpointsOf(x);
      }
      return [{ text: inline(x) }];
    });
  }
  if (isObj(v)) {
    return Object.entries(v).flatMap(([k, x]): Endpoint[] => {
      if (METHOD.test(k)) return [endpoint(k, inline(x))];
      if (k.startsWith('/') && isObj(x) && Object.keys(x).some((m) => HTTP_METHODS.has(m.toLowerCase()))) {
        return Object.entries(x).map(([m, d]) => (HTTP_METHODS.has(m.toLowerCase()) ? endpoint(`${m} ${k}`, inline(d)) : { text: `${k} ${m}: ${inline(d)}` }));
      }
      if (k.startsWith('/') && typeof x === 'string' && /^\s*(GET|POST|PUT|PATCH|DELETE)\b/i.test(x)) {
        return x.split(/[\s,|/]+/).filter((m) => HTTP_METHODS.has(m.toLowerCase())).map((m) => endpoint(`${m} ${k}`));
      }
      return [{ text: `${k}: ${inline(x)}` }];
    });
  }
  return [{ text: inline(v) }];
}

function isParamSegment(s: string): boolean {
  return /^[:{<*]/.test(s) || /[}>]$/.test(s);
}

/** CRUD operation of an endpoint (item path vs collection path); undefined for custom actions. */
function opOfEndpoint(e: Endpoint): Operation | undefined {
  if (e.method === undefined || e.path === undefined) return undefined;
  const segs = e.path.split('?')[0]?.split('/').filter((s) => s.length > 0) ?? [];
  const last = segs[segs.length - 1];
  if (last === undefined) return undefined;
  if (isParamSegment(last)) {
    if (e.method === 'GET') return 'get';
    if (e.method === 'PUT' || e.method === 'PATCH') return 'update';
    if (e.method === 'DELETE') return 'delete';
    return undefined;
  }
  if (segs.slice(0, -1).some(isParamSegment)) return undefined; // nested action (e.g. /todos/:id/archive)
  if (e.method === 'GET') return 'list';
  if (e.method === 'POST') return 'create';
  return undefined;
}

/** The resource segment of an endpoint path: the first segment that is not a version, `api`, or a parameter. */
function resourceSegment(e: Endpoint): string | undefined {
  const segs = e.path?.split('?')[0]?.split('/').filter((s) => s.length > 0) ?? [];
  return segs.find((s) => !isParamSegment(s) && !/^(v\d+|api)$/i.test(s));
}

function opsOf(v: unknown, where: string, notes: string[], endpoints: Endpoint[], warn: (s: string) => void): Set<Operation> {
  const out = new Set<Operation>();
  let words: string[] = [];
  if (typeof v === 'string') words = v.split(/[\s,|/]+/);
  else if (Array.isArray(v)) words = v.flatMap((x) => (typeof x === 'string' && METHOD.test(x) ? [x] : typeof x === 'string' ? x.split(/[\s,|]+/) : [inline(x)]));
  else if (isObj(v)) words = Object.entries(v).filter(([, x]) => boolOf(x) !== false).map(([k]) => k);
  else if (v !== null && v !== undefined) words = [inline(v)];
  for (const w of words.map((x) => x.trim()).filter((x) => x.length > 0)) {
    if (METHOD.test(w)) {
      endpoints.push(endpoint(w));
      continue;
    }
    const ops = OP_ALIASES[normKey(w)];
    if (ops !== undefined) for (const o of ops) out.add(o);
    else {
      notes.push(`operation: ${w}`);
      warn(`${where}: operation "${w}" is not one of list/get/create/update/delete; kept as a resource note`);
    }
  }
  return out;
}

// ───────────────────────────── resources ─────────────────────────────

/** Resource name as a lower-case, kebab-case singular noun (`Order Items` -> `order-item`). */
function resourceName(raw: string): string {
  const kebab = slugify(raw.replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2'));
  const parts = kebab.split('-');
  return parts.map((p, i) => (i === parts.length - 1 ? pluralize.singular(p) : p)).join('-');
}

interface ResourceOut {
  spec: Obj;
  name: string;
  explicitOps: boolean;
  ops: Set<Operation>;
}

interface ResourceEntry {
  name: string | undefined;
  spec: unknown;
  at: string;
}

function resourceEntries(v: unknown, at: string, err: (s: string) => void): ResourceEntry[] {
  const hasResourceKeys = (o: Obj): boolean => Object.keys(o).some((k) => [...RES.name, ...RES_STRUCTURAL].includes(normKey(k)));
  if (Array.isArray(v)) {
    return v.flatMap((it, i): ResourceEntry[] => {
      if (typeof it === 'string' && it.trim() !== '') return [{ name: it.trim(), spec: null, at: `${at}.${i}` }];
      if (isObj(it) && hasResourceKeys(it)) return [{ name: undefined, spec: it, at: `${at}.${i}` }];
      if (isObj(it) && Object.keys(it).length === 1) {
        const [k, x] = Object.entries(it)[0] ?? ['', null];
        return [{ name: k, spec: x, at: `${at}.${k}` }];
      }
      err(`${at}.${i}: resource has no name (${inline(it).slice(0, 60)})`);
      return [];
    });
  }
  if (isObj(v)) {
    const structural = Object.keys(v).some((k) => RES_STRUCTURAL.includes(normKey(k)));
    if (structural || (hasResourceKeys(v) && !Object.values(v).every((x) => isObj(x)))) return [{ name: undefined, spec: v, at }];
    return Object.entries(v).map(([k, x]) => ({ name: k, spec: x, at: `${at}.${k}` }));
  }
  if (typeof v === 'string') {
    return v.split(/[,\n]/).map((s) => s.trim().replace(BULLET, '')).filter((s) => s.length > 0).map((s, i) => ({ name: s, spec: null, at: `${at}.${i}` }));
  }
  if (v !== null && v !== undefined) err(`${at}: cannot read resources from ${JSON.stringify(v)}`);
  return [];
}

function resource(entry: ResourceEntry, behaviours: string[], warn: (s: string) => void, err: (s: string) => void): ResourceOut | null {
  const { spec, at } = entry;
  let rawName = entry.name;
  const notes: string[] = [];
  let fields: Obj[] = [];
  let plural: string | undefined;
  let ops = new Set<Operation>();
  let explicitOps = false;
  const endpoints: Endpoint[] = [];
  const values = isObj(spec) ? Object.values(spec) : [];
  const bareFieldMap =
    isObj(spec) && rawName !== undefined && values.length > 0 && values.every(fieldLike) && !Object.keys(spec).some((k) => RES_STRUCTURAL.includes(normKey(k)));
  if (bareFieldMap) {
    // `car: {make: string, name: string}`: the whole map is fields (a field may be called "name").
    fields = fieldsOf(spec, `${at}.fields`, warn, err);
  } else if (isObj(spec)) {
    const used = new Set<string>();
    const nameHit = pickOne(spec, RES.name, used, isScalar);
    if (nameHit !== undefined) {
      if (rawName === undefined) rawName = String(nameHit[1]);
      else if (resourceName(String(nameHit[1])) !== resourceName(rawName)) notes.push(`${nameHit[0]}: ${String(nameHit[1])}`);
    }
    const pluralHit = pickOne(spec, RES.plural, used, isText);
    if (pluralHit !== undefined) plural = slugify(String(pluralHit[1]));
    const fieldHits = pick(spec, RES.fields, used);
    const opHits = pick(spec, RES.operations, used);
    const epHits = pick(spec, RES.endpoints, used);
    const noteHits = pick(spec, RES.notes, used);
    const rest = Object.entries(spec).filter(([k]) => !used.has(k));
    const structural = fieldHits.length + opHits.length + epHits.length + (pluralHit !== undefined ? 1 : 0) > 0;
    // A spec with no structural key whose values all read as field specs IS the field map (`car: {make: string}`).
    const asFieldMap = !structural && rest.length + noteHits.length > 0 && [...rest, ...noteHits].every(([, x]) => fieldLike(x));
    const where = `${at}.fields`;
    for (const [, x] of fieldHits) fields.push(...fieldsOf(x, where, warn, err));
    if (asFieldMap) fields.push(...fieldsOf(Object.fromEntries([...noteHits, ...rest]), where, warn, err));
    else {
      for (const [, x] of noteHits) notes.push(inline(x));
      for (const [k, x] of rest) {
        notes.push(`${k}: ${inline(x)}`);
        warn(`${at}: "${k}" kept as a resource note`);
      }
    }
    for (const [, x] of opHits) {
      explicitOps = true;
      ops = new Set([...ops, ...opsOf(x, at, notes, endpoints, warn)]);
    }
    for (const [, x] of epHits) endpoints.push(...endpointsOf(x));
  } else if (Array.isArray(spec)) {
    fields = fieldsOf(spec, `${at}.fields`, warn, err);
  } else if (typeof spec === 'string' && spec.trim() !== '') {
    notes.push(spec.trim());
  }
  if (rawName === undefined || rawName.trim() === '') {
    err(`${at}: resource has no name`);
    return null;
  }
  const name = resourceName(rawName);
  if (name !== rawName) warn(`${at}: resource "${rawName}" -> "${name}" (lower-case singular)`);
  if (fields.length === 0) warn(`${at}: resource "${name}" lists no fields; the model derives them from the brief and behaviours`);
  for (const e of endpoints) {
    behaviours.push(`Endpoint: ${e.text}`);
    const op = opOfEndpoint(e);
    if (op !== undefined) ops.add(op);
  }
  if (endpoints.length > 0) explicitOps = true;
  return {
    name,
    explicitOps,
    ops,
    spec: { name, ...(plural !== undefined ? { plural } : {}), fields, ...(notes.length > 0 ? { notes } : {}) },
  };
}

// ───────────────────────────── limits & scope ─────────────────────────────

function limitsOf(v: unknown, warn: (s: string) => void): Obj | undefined {
  if (!isObj(v)) {
    warn(`limits: ignored (expected a mapping, got ${inline(v)})`);
    return undefined;
  }
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    const n = normKey(k);
    const key = ['maxturns', 'turns', 'maxsteps', 'steps'].includes(n)
      ? 'maxTurns'
      : ['maxoutputtokens', 'maxtokens', 'outputtokens', 'maxoutput'].includes(n)
        ? 'maxOutputTokens'
        : undefined;
    if (isProviderKey(k, x)) continue; // reported as an error already
    if (key === undefined) warn(`limits.${k}: ignored (known limits: maxTurns, maxOutputTokens)`);
    else out[key] = numberOf(x) ?? x;
  }
  return out;
}

function globsOf(v: unknown): string[] {
  return items(v).flatMap((s) => s.split(/\s*,\s*/)).filter((s) => s.length > 0);
}

function scopeOf(v: unknown, warn: (s: string) => void): Obj {
  if (!isObj(v)) return { allow: globsOf(v) };
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    const n = normKey(k);
    if (['allow', 'include', 'includes', 'write', 'writable', 'paths', 'files', 'allowed'].includes(n)) out.allow = [...globsOf(out.allow), ...globsOf(x)];
    else if (['deny', 'exclude', 'excludes', 'readonly', 'protected', 'forbid', 'forbidden', 'denied', 'ignore'].includes(n)) out.deny = [...globsOf(out.deny), ...globsOf(x)];
    else warn(`scope.${k}: ignored (scope has allow and deny)`);
  }
  return out;
}

// ───────────────────────────── the front end ─────────────────────────────

/** Strip known task-file extensions (and a `.task` infix) from a file name. */
function stem(file: string): string {
  return basename(file).replace(/\.(ya?ml|json|md|markdown|txt|text)$/i, '').replace(/\.task$/i, '');
}

export function normalizeTaskData(data: unknown, opts: NormalizeOptions): Normalized {
  const warnings: string[] = [];
  const errors: string[] = [];
  const warn = (s: string): void => {
    warnings.push(s);
  };
  const err = (s: string): void => {
    errors.push(s);
  };
  let root: Obj;
  if (typeof data === 'string') root = { brief: data };
  else if (isObj(data)) root = data;
  else {
    err(`(root): a task file must be a mapping of keys or free text, got ${Array.isArray(data) ? 'a list' : JSON.stringify(data)}`);
    return { candidate: {}, warnings, errors };
  }
  errors.push(...providerKeyErrors(root));
  const used = new Set<string>();
  for (const [k, v] of Object.entries(root)) if (isProviderKey(k, v)) used.add(k);

  // kind: the canonical key must hold a kind; an alias only counts when its value reads as one.
  let explicitKind: TaskKind | undefined;
  for (const [k, v] of Object.entries(root)) {
    const n = normKey(k);
    if (used.has(k) || !TOP.kind.includes(n)) continue;
    const kv = kindValue(v, n !== 'kind');
    if (kv !== undefined) {
      used.add(k);
      if (explicitKind !== undefined && explicitKind !== kv) err(`${k}: says ${kv} but another key says ${explicitKind}`);
      explicitKind ??= kv;
      if (k !== 'kind' || v !== kv) warn(`${k}: "${inline(v)}" read as kind ${kv}`);
    } else if (n === 'kind') {
      used.add(k);
      err(`kind: "${inline(v)}" is not a task kind (greenfield = build a new API, brownfield = change an existing one)`);
    }
  }

  // A file that is itself one resource (top-level fields) instead of a resources list.
  const resourceHits = pick(root, TOP.resources, used, (v) => v !== null && v !== undefined);
  const resourceEntriesAll: ResourceEntry[] = [];
  for (const [k, v] of resourceHits) resourceEntriesAll.push(...resourceEntries(v, k, err));
  if (resourceHits.length === 0 && Object.keys(root).some((k) => !used.has(k) && FIELDS_KEYS.includes(normKey(k)))) {
    const own = new Set<string>();
    const spec: Obj = {};
    const nameHit = pickOne(root, ['resource', 'entity', 'name'], own, isScalar);
    for (const [k, v] of [...(nameHit !== undefined ? [nameHit] : []), ...pick(root, RES_STRUCTURAL, own)]) spec[k] = v;
    for (const k of own) used.add(k);
    resourceEntriesAll.push({ name: undefined, spec, at: '(root)' });
    warn('(root): the file describes one resource (top-level fields)');
  }

  const titleHit = pickOne(root, TOP.title, used, isScalar);
  const idHit = pickOne(root, TOP.id, used, isScalar);
  const outputHit = pickOne(root, TOP.output, used, isText);
  const targetHit =
    pickOne(root, TOP.targetStrong, used, isText) ??
    (explicitKind === 'greenfield' ? undefined : pickOne(root, TOP.targetWeak, used, explicitKind === 'brownfield' ? isText : pathLike));
  const changeText = pick(root, TOP.change, used).map(([, v]) => textOf(v)).filter((x): x is string => x !== undefined).join('\n\n');
  let brief = pick(root, TOP.brief, used).map(([, v]) => textOf(v)).filter((x): x is string => x !== undefined).join('\n\n');
  const behaviours: string[] = [];
  for (const [, v] of pick(root, TOP.behaviours, used)) behaviours.push(...items(v));
  const topEndpoints: Endpoint[] = [];
  for (const [, v] of pick(root, TOP.endpoints, used)) topEndpoints.push(...endpointsOf(v));
  const topOps = pick(root, TOP.operations, used);

  // kind: explicit, else inferred from what the file (and the CLI) names.
  const target = opts.target ?? (targetHit !== undefined ? String(targetHit[1]) : undefined);
  const output = opts.output ?? (outputHit !== undefined ? String(outputHit[1]) : undefined);
  const targetSrc = opts.target !== undefined ? '--target' : `"${targetHit?.[0] ?? ''}"`;
  const outputSrc = opts.output !== undefined ? '--output' : `"${outputHit?.[0] ?? ''}"`;
  let kind: TaskKind;
  if (explicitKind !== undefined) {
    kind = explicitKind;
    if (kind === 'greenfield' && target !== undefined) err(`kind is greenfield (build a new API) but ${targetSrc} names an existing API to change`);
    if (kind === 'brownfield' && output !== undefined) err(`kind is brownfield (change an existing API) but ${outputSrc} names a new output directory`);
  } else if (output !== undefined && (target !== undefined || changeText !== '')) {
    kind = 'greenfield';
    err(`cannot tell the kind: ${outputSrc} says build a new API, ${target !== undefined ? targetSrc : '"change"'} says change an existing one; add kind: greenfield or kind: brownfield`);
  } else if (target !== undefined || changeText !== '') {
    kind = 'brownfield';
    warn(`kind inferred: brownfield (${target !== undefined ? targetSrc : '"change"'} given)`);
  } else {
    kind = 'greenfield';
    warn('kind inferred: greenfield (no target or change given)');
  }

  // title, then id (file name first), then the title fallback from the id.
  let title = titleHit !== undefined ? String(titleHit[1]).replace(/\s+/g, ' ').trim() : undefined;
  if (title === undefined) {
    const from = titleFrom(brief !== '' ? brief : changeText);
    if (from !== undefined) {
      title = from;
      warn(`title inferred: "${title}"`);
    }
  }
  let id: string;
  if (idHit !== undefined) {
    const raw = String(idHit[1]).trim();
    id = /^[a-z0-9][a-z0-9-]*$/.test(raw) ? raw : slugify(raw);
    if (id !== raw) warn(`id "${raw}" -> "${id}"`);
    if (id === '') err(`id: "${raw}" has no letters or digits`);
  } else {
    id = slugify(stem(opts.file)) || slugify((title ?? '').split(/\s+/).slice(0, 6).join(' ')) || 'task';
    warn(`id inferred: ${id}`);
  }
  if (title === undefined) {
    title = id.replace(/-/g, ' ');
    warn(`title inferred: "${title}"`);
  }

  // resources (+ endpoints and operations given at the top level).
  const resources: ResourceOut[] = [];
  for (const e of resourceEntriesAll) {
    const r = resource(e, behaviours, warn, err);
    if (r !== null) resources.push(r);
  }
  const only = resources.length === 1 ? resources[0] : undefined;
  for (const [k, v] of topOps) {
    if (only === undefined) {
      used.delete(k); // not attributable to one resource: carried verbatim
      continue;
    }
    const notes: string[] = [];
    only.ops = new Set([...only.ops, ...opsOf(v, k, notes, topEndpoints, warn)]);
    only.explicitOps = true;
    if (notes.length > 0) only.spec.notes = [...(Array.isArray(only.spec.notes) ? only.spec.notes : []), ...notes];
  }
  for (const e of topEndpoints) {
    behaviours.push(`Endpoint: ${e.text}`);
    const seg = resourceSegment(e);
    const r = seg === undefined ? undefined : resources.find((x) => x.name === resourceName(seg) || x.spec.plural === slugify(seg));
    const op = opOfEndpoint(e);
    if (r !== undefined && op !== undefined) {
      r.ops.add(op);
      r.explicitOps = true;
    }
  }
  const resourceSpecs = resources.map((r) => ({ ...r.spec, ...(r.explicitOps && r.ops.size > 0 ? { operations: ALL_OPS.filter((o) => r.ops.has(o)) } : {}) }));

  // pass-through canonical keys.
  const templateHit = pickOne(root, TOP.template, used, isText);
  const basePathHit = pickOne(root, TOP.basePath, used, isText);
  const scopeHit = pickOne(root, TOP.scope, used);
  const breakingHit = pickOne(root, TOP.allowBreaking, used);
  const standardsHit = pickOne(root, TOP.standards, used);
  const limitsHit = pickOne(root, TOP.limits, used);

  const carried: Obj = {};
  const carry = (k: string, v: unknown, why: string): void => {
    carried[k] = v;
    warn(`top-level "${k}" ${why}; carried to the model verbatim`);
  };
  const candidate: Obj = { kind, id, title };
  if (kind === 'greenfield') {
    const out = output !== undefined ? cleanPath(output) : `generated/${id}`;
    if (output === undefined) warn(`output inferred: ${out}`);
    else if (opts.output !== undefined) warn(`output set by --output: ${out}`);
    else if (isAbsolutePath(out)) warn(`output "${out}" is absolute (non-portable); prefer a path relative to --repo`);
    candidate.output = out;
    if (changeText !== '') {
      brief = [brief, changeText].filter((x) => x !== '').join('\n\n');
      warn('"change" text added to the brief (greenfield task)');
    }
    if (templateHit !== undefined) {
      const t = slugify(String(templateHit[1]));
      if (t !== templateHit[1]) warn(`template "${String(templateHit[1])}" -> "${t}"`);
      candidate.template = t;
    }
    if (basePathHit !== undefined) {
      const raw = String(basePathHit[1]).trim();
      const bp = raw === '/' ? '/' : `/${raw.replace(/^\/+|\/+$/g, '')}`;
      if (bp !== raw) warn(`basePath "${raw}" -> "${bp}"`);
      candidate.basePath = bp;
    }
    candidate.resources = resourceSpecs;
    if (scopeHit !== undefined) carry(scopeHit[0], scopeHit[1], 'has no effect on a greenfield task (the template decides what is writable)');
    if (breakingHit !== undefined) carry(breakingHit[0], breakingHit[1], 'has no effect on a greenfield task');
    if (standardsHit !== undefined) carry(standardsHit[0], standardsHit[1], 'has no effect on a greenfield task (its standards are always 100% over the whole API)');
  } else {
    const tgt = target !== undefined ? cleanPath(target) : '.';
    if (target === undefined) warn('target inferred: "." (the --repo directory)');
    else if (opts.target !== undefined) warn(`target set by --target: ${tgt}`);
    else if (isAbsolutePath(tgt)) warn(`target "${tgt}" is absolute (non-portable); prefer --repo <dir> with target "."`);
    candidate.target = tgt;
    let change = [changeText, brief].filter((x) => x !== '').join('\n\n');
    brief = '';
    if (change === '' && behaviours.length > 0) {
      change = 'Make the existing API satisfy every acceptance criterion below.';
      warn('change inferred from the acceptance criteria (no change/description given)');
    }
    if (change !== '') candidate.change = change;
    if (scopeHit !== undefined) candidate.scope = scopeOf(scopeHit[1], warn);
    if (breakingHit !== undefined) candidate.allowBreaking = boolOf(breakingHit[1]) ?? breakingHit[1];
    if (standardsHit !== undefined) candidate.standards = standardsModeOf(standardsHit[1], warn);
    if (resourceSpecs.length > 0) candidate.resources = resourceSpecs;
    if (templateHit !== undefined) carry(templateHit[0], templateHit[1], 'has no effect on a brownfield task');
    if (basePathHit !== undefined) carry(basePathHit[0], basePathHit[1], 'has no effect on a brownfield task');
  }
  if (limitsHit !== undefined) {
    const l = limitsOf(limitsHit[1], warn);
    if (l !== undefined) candidate.limits = l;
  }
  candidate.behaviours = behaviours;
  if (brief !== '') candidate.brief = brief;
  for (const [k, v] of Object.entries(root)) {
    if (!used.has(k)) carry(k, v, 'has no slot in the task schema');
  }
  if (Object.keys(carried).length > 0) candidate.carried = carried;
  return { candidate, warnings, errors };
}
