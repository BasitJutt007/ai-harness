/**
 * The lenient task-file front end: task files written by someone else (other key names, other
 * shapes, free text) load to the canonical task, deterministically, with every rename/inference/
 * drop reported; what must stay an error (provider keys, contradictions, invalid specs) still fails,
 * and every issue is reported at once.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { decodeTask, loadTask, normalizedSha256, normalizeTask, MAX_BRIEF_CHARS } from '../../src/core/task.ts';
import type { BrownfieldTask, FieldSpec, GreenfieldTask, Task } from '../../src/core/types.ts';

const FIXTURES = join(HARNESS_ROOT, 'test', 'fixtures', 'tasks');

/** Decode + normalize text as if it were the file `name` (no filesystem). */
function load(text: string, name = 'sample.task.yaml', opts: { strict?: boolean; target?: string; output?: string } = {}): { task: Task; warnings: string[] } {
  return normalizeTask(decodeTask(text, name, opts.strict === true).data, { ...opts, source: name, file: name });
}

function loadErr(text: string, name = 'sample.task.yaml', opts: { strict?: boolean; target?: string; output?: string } = {}): string {
  try {
    load(text, name, opts);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`expected ${name} to be rejected`);
}

function green(t: Task): GreenfieldTask {
  if (t.kind !== 'greenfield') throw new Error(`expected greenfield, got ${t.kind}`);
  return t;
}

function brown(t: Task): BrownfieldTask {
  if (t.kind !== 'brownfield') throw new Error(`expected brownfield, got ${t.kind}`);
  return t;
}

/** Field shorthand for expectations: only the keys that matter. */
function f(name: string, type: FieldSpec['type'], extra: Partial<FieldSpec> = {}): Partial<FieldSpec> {
  return { name, type, ...extra };
}

describe('sample task files written by others (test/fixtures/tasks)', () => {
  const expected: Record<string, Record<string, unknown>> = {
    '01-single-resource.yaml': {
      kind: 'greenfield', id: 'books-api', title: 'Books API', output: 'generated/books-api', behaviours: ['POST /v1/books returns 201'],
      resources: [{ name: 'book', plural: 'books', fields: [f('title', 'string', { required: true }), f('isbn', 'string', { unique: true, required: false })] }],
    },
    '02-fields-map.yaml': {
      kind: 'greenfield', id: 'contacts-api',
      resources: [{ name: 'contact', fields: [f('email', 'email', { required: true, unique: true }), f('name', 'string', { required: true }), f('phone', 'string', { required: false })] }],
    },
    '03-fields-strings.yaml': {
      kind: 'greenfield', id: 'members-api',
      resources: [{ name: 'member', fields: [f('email', 'string', { required: true, unique: true }), f('name', 'string', { required: true }), f('age', 'integer')] }],
    },
    '04-endpoints.json': {
      kind: 'greenfield', id: '04-endpoints', title: 'Todo API', brief: 'A simple todo list API.', output: 'generated/04-endpoints',
      behaviours: ['Endpoint: GET /todos', 'Endpoint: POST /todos', 'Endpoint: GET /todos/:id', 'Endpoint: PATCH /todos/:id', 'Endpoint: DELETE /todos/:id'],
      resources: [{ name: 'todo', operations: ['list', 'get', 'create', 'update', 'delete'], fields: [f('title', 'string', { required: true }), f('done', 'boolean', { default: false })] }],
    },
    '05-name-desc-multiline-behaviours.yaml': {
      kind: 'greenfield', title: 'Library Loans', brief: 'Members borrow books. A loan is open until returned.', output: 'generated/loans-api',
      behaviours: ['Creating a loan returns 201.', 'A loan with dueDate in the past is rejected with 422.'],
      resources: [{ name: 'loan', fields: [f('memberEmail', 'email', { required: true }), f('dueDate', 'datetime', { required: true })] }],
    },
    '06-brownfield-repo-path-description.yaml': {
      kind: 'brownfield', id: 'add-archive', title: 'Archive projects', target: 'samples/existing-api',
      change: 'Add POST /v1/projects/{projectId}/archive that sets status to archived and returns 200.',
      behaviours: ['Archiving an unknown project returns 404.'],
    },
    '06b-brownfield-path.json': {
      kind: 'brownfield', title: 'Add search to projects', target: 'samples/existing-api', change: 'GET /v1/projects accepts ?q= and filters by name substring.',
    },
    '07-free-text.yaml': { kind: 'greenfield', id: '07-free-text', resources: [], output: 'generated/07-free-text' },
    '07b-free-text-task-key.yaml': { kind: 'greenfield', id: '07b-free-text-task-key', resources: [] },
    '08-rich-types.yaml': {
      kind: 'greenfield', id: 'invoices-api',
      resources: [{
        name: 'invoice',
        fields: [
          f('amount', 'decimal', { required: true }),
          f('issuedOn', 'date', { required: true }),
          f('tags', 'array', { rawType: 'string[]' }),
          f('lines', 'array'),
          f('billingAddress', 'object'),
          f('customerId', 'uuid', { required: true }),
          f('currency', 'enum', { values: ['USD', 'EUR'] }),
        ],
      }],
    },
    '10-capitalised-plural.yaml': {
      kind: 'greenfield', id: 'shop-api', output: 'generated/shop-api',
      resources: [{
        name: 'order-item', plural: 'order-items', operations: ['list', 'get', 'create', 'update', 'delete'],
        fields: [f('quantity', 'integer', { rawType: 'int', required: true, min: 1 }), f('unit_price', 'number', { rawType: 'float', required: true })],
      }],
    },
    '11-canonical-with-notes.yaml': {
      kind: 'greenfield', id: 'notes-api', carried: { notes: 'Please use cursor pagination.' },
      resources: [{ name: 'note', fields: [f('body', 'string', { required: true, description: 'example: hello' })] }],
    },
    '12-markdown.md': { kind: 'greenfield', id: '12-markdown', title: 'Pets API', resources: [] },
    'extra/01-plus-kind.yaml': { kind: 'greenfield', id: 'books-api', resources: [{ name: 'book' }] },
    'extra/13-abs-target.yaml': { kind: 'brownfield', target: '/Users/someone/sample-api' },
    'extra/15-minimal-brownfield.yaml': { kind: 'brownfield', target: '.', change: 'Add DELETE /v1/projects/{id}.' },
    'extra/16-yaml-string-bools.yaml': { resources: [{ name: 'tag', fields: [f('label', 'string', { required: true, max: 50 })] }] },
    'extra/17-task-txt.txt': { kind: 'greenfield', title: 'Build a pets API', brief: 'Build a pets API.', resources: [] },
    'extra/cars-canonical.yaml': { resources: [{ name: 'car', fields: [f('model', 'string', { required: true })] }] },
    'extra/cars.yaml': {
      title: 'Car dealership',
      resources: [{ name: 'car', fields: [f('make', 'string', { required: true }), f('model', 'string', { required: true }), f('year', 'integer', { min: 1900 })] }],
    },
  };

  it.each(Object.entries(expected))('%s loads to the expected canonical task', async (name, want) => {
    const lt = await loadTask(join(FIXTURES, name));
    expect(lt.task).toMatchObject(want);
    // what was renamed or inferred is reported, never silent
    const raw = readFileSync(join(FIXTURES, name), 'utf8');
    const said = (k: string): boolean => new RegExp(`(^|\\n|"|\\{\\s*)${k}"?\\s*:`).test(raw);
    const notes = lt.warnings.join('\n');
    if (!said('kind')) expect(notes, `${name}: kind decided silently`).toMatch(/kind inferred|read as kind/);
    if (!said('id')) expect(notes, `${name}: id inferred silently`).toMatch(/id inferred/);
    if (lt.task.kind === 'greenfield' && !said('output')) expect(notes, `${name}: output inferred silently`).toMatch(/output inferred/);
    if (lt.task.kind === 'brownfield' && !said('target') && !said('repo') && !said('path')) expect(notes).toMatch(/target inferred/);
  });

  it('every fixture file is covered by the table (rejections included)', () => {
    const files = [...readdirSync(FIXTURES).filter((x) => x.includes('.')), ...readdirSync(join(FIXTURES, 'extra')).map((x) => `extra/${x}`)].sort();
    const rejected = ['09-model-key.yaml', 'extra/14-dotdot-target.yaml', 'extra/limits-model.yaml'];
    expect(files).toEqual([...Object.keys(expected), ...rejected].sort());
  });

  it('free text keeps the whole text verbatim as the brief and infers a title from it', async () => {
    const t = green((await loadTask(join(FIXTURES, '07-free-text.yaml'))).task);
    expect(t.brief).toBe(readFileSync(join(FIXTURES, '07-free-text.yaml'), 'utf8').trim());
    expect(t.title).toBe('Build me an API to manage bakery orders with customers and order items');
    const md = green((await loadTask(join(FIXTURES, '12-markdown.md'))).task);
    expect(md.brief).toBe('# Pets API\nBuild a pets API with name (required) and species (cat|dog).');
  });

  it('model: <id> and limits.model are still rejected; a car API with a field named model still loads', async () => {
    await expect(loadTask(join(FIXTURES, '09-model-key.yaml'))).rejects.toThrow(/\(root\): key "model" is not allowed: task files are provider-neutral/);
    await expect(loadTask(join(FIXTURES, 'extra', 'limits-model.yaml'))).rejects.toThrow(/limits: key "model" is not allowed/);
    await expect(loadTask(join(FIXTURES, 'extra', '14-dotdot-target.yaml'))).rejects.toThrow(/target: must not contain "\.\."/);
    for (const name of ['extra/cars.yaml', 'extra/cars-canonical.yaml']) {
      const t = green((await loadTask(join(FIXTURES, name))).task);
      expect(t.resources[0]?.fields.map((x) => x.name)).toContain('model');
    }
  });
});

describe('canonical files: the lenient front end changes nothing', () => {
  const canonical = [
    join(HARNESS_ROOT, 'tasks', 'users-api.task.yaml'),
    join(HARNESS_ROOT, 'tasks', 'projects-change.task.yaml'),
    join(FIXTURES, 'extra', 'cars-canonical.yaml'),
    join(FIXTURES, 'extra', '15-minimal-brownfield.yaml'),
  ];
  it.each(canonical)('%s: lenient == --strict-task, same normalized sha', async (file) => {
    const lenient = await loadTask(file);
    const strict = await loadTask(file, { strict: true });
    expect(lenient.task).toEqual(strict.task);
    expect(lenient.normalizedSha256).toBe(strict.normalizedSha256);
    expect(lenient.warnings).toEqual([]);
  });

  it('normalizing the canonical output again is a fixed point (task.normalized.json reloads identically)', async () => {
    for (const name of Object.keys({ '04-endpoints.json': 1, '08-rich-types.yaml': 1, '10-capitalised-plural.yaml': 1, '11-canonical-with-notes.yaml': 1, '12-markdown.md': 1 })) {
      const lt = await loadTask(join(FIXTURES, name));
      const again = normalizeTask(JSON.parse(JSON.stringify(lt.task)), { strict: true, source: name });
      expect(again.task).toEqual(lt.task);
      expect(normalizedSha256(again.task)).toBe(lt.normalizedSha256);
    }
  });
});

describe('kind: explicit spellings and inference', () => {
  const brownBase = 'title: T\nchange: Add a thing.\n';
  it.each([
    ['kind: greenfield', 'greenfield'],
    ['kind: Greenfield', 'greenfield'],
    ['type: new', 'greenfield'],
    ['mode: scaffold', 'greenfield'],
    ['task_type: build', 'greenfield'],
    ['kind: brownfield', 'brownfield'],
    ['type: brownfield', 'brownfield'],
    ['mode: existing', 'brownfield'],
    ['kind: change', 'brownfield'],
    ['type: modify', 'brownfield'],
    ['kind: new feature on the existing API', 'brownfield'],
    ['kind: brand new service', 'greenfield'],
  ])('%s -> %s', (line, kind) => {
    const body = kind === 'greenfield' ? `${line}\ntitle: T\nbrief: Build it.\n` : `${line}\n${brownBase}`;
    expect(load(body).task.kind).toBe(kind);
  });

  it.each([
    ['target: their-api', 'brownfield'],
    ['repo: ./their-api', 'brownfield'],
    ['repository: /abs/their-api', 'brownfield'],
    ['codebase: apis/orders', 'brownfield'],
    ['path: apis/orders', 'brownfield'],
    ['project: ./orders', 'brownfield'],
    ['change: add a field', 'brownfield'],
    ['changes: [add a field]', 'brownfield'],
    ['output: out/api', 'greenfield'],
    ['resources: [{name: user, fields: {email: email}}]', 'greenfield'],
    ['brief: Build a todo API.', 'greenfield'],
    ['description: Build a todo API.', 'greenfield'],
  ])('inferred from %s -> %s (and noted)', (line, kind) => {
    // a brownfield needs a change and a greenfield resources or a brief: add one when the line gives neither
    const filler = kind === 'brownfield' ? (/change/.test(line) ? '' : 'description: do it\n') : /resources|brief|description/.test(line) ? '' : 'brief: x\n';
    const r = load(`title: T\n${line}\n${filler}`);
    expect(r.task.kind).toBe(kind);
    expect(r.warnings.join('\n')).toMatch(new RegExp(`kind inferred: ${kind}`));
  });

  it('a weak alias that is not a path (project: Bakery) is not a target: it is carried', () => {
    const r = load('title: Bakery\nproject: Bakery\nbrief: Build a bakery API.\n');
    expect(r.task.kind).toBe('greenfield');
    expect(r.task.carried).toEqual({ project: 'Bakery' });
  });

  it.each(['REST API', 'REST API built with new tooling'])('type: %s is not a kind: it is carried, and the kind is inferred', (value) => {
    const r = load(`type: ${value}\ntitle: T\nbrief: Build it.\n`);
    expect(r.task.kind).toBe('greenfield');
    expect(r.task.carried).toEqual({ type: value });
    expect(r.warnings.join('\n')).toMatch(/kind inferred/);
  });

  it.each([
    ['kind: greenfield\ntitle: T\ntarget: their-api\nbrief: x\n', /kind is greenfield .* names an existing API/],
    ['kind: brownfield\ntitle: T\noutput: out/api\nchange: x\n', /kind is brownfield .* names a new output directory/],
    ['title: T\noutput: out/api\ntarget: their-api\n', /cannot tell the kind/],
    ['title: T\noutput: out/api\nchange: add a field\n', /cannot tell the kind/],
    ['kind: banana\ntitle: T\nbrief: x\n', /kind: "banana" is not a task kind/],
    ['kind: greenfield\ntype: brownfield\ntitle: T\nbrief: x\n', /says brownfield but another key says greenfield/],
  ])('contradictory or unknown kind is an error: %#', (body, msg) => {
    expect(loadErr(body)).toMatch(msg);
  });
});

describe('resources: list, single object, map, shorthand; names normalized', () => {
  const FIELDS = '{email: {type: email, required: true}}';
  it.each([
    ['list of objects', `resources:\n  - name: user\n    fields: ${FIELDS}\n`],
    ['single object under resource:', `resource:\n  name: user\n  fields: ${FIELDS}\n`],
    ['single object under entity:', `entity: {name: user, fields: ${FIELDS}}\n`],
    ['map name -> spec', `resources:\n  user:\n    fields: ${FIELDS}\n`],
    ['map name -> field map', 'resources:\n  user:\n    email: {type: email, required: true}\n'],
    ['map name -> field strings', 'entities:\n  user:\n    email: email, required\n'],
    ['list of one-key maps', `resources:\n  - user:\n      fields: ${FIELDS}\n`],
    ['models: map (data models, not a model id)', `models:\n  user:\n    fields: ${FIELDS}\n`],
    ['model: one data model with fields', `model:\n  name: user\n  fields: ${FIELDS}\n`],
    ['the file is the resource (top-level fields)', `name: user\nfields: ${FIELDS}\n`],
    ['tables: list', `tables:\n  - name: users\n    columns: ${FIELDS}\n`],
  ])('%s', (_label, body) => {
    const t = green(load(`title: Users\n${body}`).task);
    expect(t.resources).toHaveLength(1);
    expect(t.resources[0]).toMatchObject({ name: 'user', plural: 'users', fields: [{ name: 'email', type: 'email', required: true }] });
  });

  it.each([
    ['user', 'user'],
    ['User', 'user'],
    ['Users', 'user'],
    ['order item', 'order-item'],
    ['Order Item', 'order-item'],
    ['OrderItems', 'order-item'],
    ['order_items', 'order-item'],
    ['ORDER-ITEMS', 'order-item'],
    ['HTTPLogs', 'http-log'],
    ['categories', 'category'],
  ])('resource name %s -> %s', (raw, name) => {
    const r = load(`title: T\nresources:\n  - name: ${raw}\n    fields: {label: string}\n`);
    expect(green(r.task).resources[0]?.name).toBe(name);
    if (raw !== name) expect(r.warnings.join('\n')).toContain(`resource "${raw}" -> "${name}"`);
  });

  it('several resources in a map keep their order; names without fields load with a note', () => {
    const r = load('title: Shop\nresources:\n  customer: {name: string, email: email}\n  order: {total: decimal}\n  invoice:\n');
    const t = green(r.task);
    expect(t.resources.map((x) => x.name)).toEqual(['customer', 'order', 'invoice']);
    // a field may itself be called "name" when the map is a bare field map
    expect(t.resources[0]?.fields.map((x) => x.name)).toEqual(['name', 'email']);
    expect(r.warnings.join('\n')).toMatch(/resource "invoice" lists no fields/);
    expect(green(load('title: T\nresources: [customer, order]\n').task).resources.map((x) => x.name)).toEqual(['customer', 'order']);
  });

  it('resource-level extras (relations, rules) become resource notes, not errors', () => {
    const r = load('title: T\nresources:\n  - name: order\n    fields: {total: decimal}\n    relations: belongs to customer\n    description: A placed order.\n');
    expect(green(r.task).resources[0]?.notes).toEqual(['A placed order.', 'relations: belongs to customer']);
    expect(r.warnings.join('\n')).toMatch(/"relations" kept as a resource note/);
  });

  it('a resource with no name is an error', () => {
    expect(loadErr('title: T\nresources:\n  - fields: {a: string}\n    plural: things\n')).toMatch(/resources\.0: resource has no name/);
  });
});

describe('fields: every shape of the same spec yields the same canonical fields', () => {
  const want = [
    f('email', 'email', { required: true, unique: true }),
    f('age', 'integer', { min: 0, max: 130 }),
    f('status', 'enum', { values: ['active', 'archived'], default: 'active' }),
  ];
  const shapes: Array<[string, string]> = [
    ['list of objects', `- {name: email, type: email, required: true, unique: true}
- {name: age, type: integer, min: 0, max: 130}
- {name: status, type: enum, values: [active, archived], default: active}`],
    ['map name -> object', `email: {type: email, required: true, unique: true}
age: {type: int, minimum: 0, maximum: 130}
status: {enum: [active, archived], default: active}`],
    ['map name -> string', `email: "email, required, unique"
age: "integer, min 0, max 130"
status: "enum(active|archived), default active"`],
    ['list of strings', `- "email: email, required, unique"
- "age: integer, min 0, max 130"
- "status: active|archived, default active"`],
    ['list of one-key maps', `- email: {type: string, format: email, required: "yes", unique: true}
- age: {type: integer, min: "0", max: "130"}
- status: {type: string, options: [active, archived], default: active}`],
    ['space-separated strings', `- "email email required unique"
- "age integer min 0 max 130"
- "status enum(active|archived) default active"`],
  ];
  it.each(shapes)('%s', (_label, fieldsYaml) => {
    const body = `title: T\nresources:\n  - name: person\n    fields:\n${fieldsYaml.split('\n').map((l) => `      ${l}`).join('\n')}\n`;
    const fields = green(load(body).task).resources[0]?.fields ?? [];
    expect(fields.map((x) => x.name)).toEqual(['email', 'age', 'status']);
    want.forEach((w, i) => expect(fields[i]).toMatchObject(w));
  });

  it.each([
    ['string', 'string', undefined],
    ['text', 'string', 'text'],
    ['varchar', 'string', 'varchar'],
    ['Email', 'email', undefined],
    ['guid', 'uuid', 'guid'],
    ['int', 'integer', 'int'],
    ['bigint', 'integer', 'bigint'],
    ['float', 'number', 'float'],
    ['double', 'number', 'double'],
    ['decimal', 'decimal', undefined],
    ['money', 'decimal', 'money'],
    ['bool', 'boolean', 'bool'],
    ['date-time', 'datetime', undefined],
    ['timestamp', 'datetime', 'timestamp'],
    ['date', 'date', undefined],
    ['time', 'time', undefined],
    ['string[]', 'array', 'string[]'],
    ['array<OrderItem>', 'array', 'array<OrderItem>'],
    ['list of strings', 'array', 'list of strings'],
    ['json', 'object', 'json'],
    ['object', 'object', undefined],
    ['Customer', 'unknown', 'Customer'],
    ['url', 'unknown', 'url'],
  ])('declared type %s -> %s (rawType %s, printed as declared)', (declared, type, rawType) => {
    const fld = green(load(`title: T\nresources: [{name: x, fields: [{name: v, type: "${declared}"}]}]\n`).task).resources[0]?.fields[0];
    expect(fld?.type).toBe(type);
    expect(fld?.rawType).toBe(rawType);
  });

  it.each([
    ['minLength: 3', { min: 3 }],
    ['maxLength: "20"', { max: 20 }],
    ['length: 2', { min: 2, max: 2 }],
    ['required: "no"', { required: false }],
    ['required: 1', { required: true }],
    ['optional: true', { required: false }],
    ['readOnly: true', { readOnly: true }],
    ['read_only: yes', { readOnly: true }],
    ['unique: "true"', { unique: true }],
    ['choices: "a|b"', { type: 'enum', values: ['a', 'b'] }],
    ['oneOf: [a, b]', { type: 'enum', values: ['a', 'b'] }],
    ['format: uuid', { type: 'uuid' }],
    ['format: date-time', { type: 'datetime' }],
    ['nullable: true', { description: 'nullable' }],
    ['example: abc', { description: 'example: abc' }],
    ['pattern: "^[a-z]+$"', { description: 'pattern: ^[a-z]+$' }],
  ])('field key alias %s', (kv, want) => {
    const fld = green(load(`title: T\nresources: [{name: x, fields: [{name: v, type: string, ${kv}}]}]\n`).task).resources[0]?.fields[0];
    expect(fld).toMatchObject(want);
  });

  it('a field without a type is "unknown" (printed "unspecified type"), with a note', () => {
    const r = load('title: T\nresources: [{name: todo, fields: [title, done]}]\n');
    expect(green(r.task).resources[0]?.fields).toMatchObject([f('title', 'unknown'), f('done', 'unknown')]);
    expect(r.warnings.join('\n')).toMatch(/fields\.title: no type given/);
  });

  it('field names become identifiers (noted); server-managed names are dropped (noted)', () => {
    const r = load('title: T\nresources:\n  - name: person\n    fields:\n      first name: string\n      last-name: string\n      id: uuid\n      created_at: datetime\n      updatedAt: datetime\n');
    expect(green(r.task).resources[0]?.fields.map((x) => x.name)).toEqual(['firstName', 'lastName']);
    expect(r.warnings.filter((w) => /server-managed/.test(w))).toHaveLength(3);
    expect(r.warnings.join('\n')).toContain('field "first name" -> "firstName"');
  });

  it('`a|b` is a list of values, `string|null` a union type (printed as declared, noted nullable)', () => {
    const t = green(load('title: T\nresources:\n  order:\n    status: pending|paid\n    nickname: string|null\n    ref: uuid | int\n').task);
    expect(t.resources[0]?.fields).toMatchObject([
      f('status', 'enum', { values: ['pending', 'paid'] }),
      f('nickname', 'string', { rawType: 'string|null', description: 'nullable' }),
      f('ref', 'uuid', { rawType: 'uuid | int' }),
    ]);
  });

  it('values on a non-string type are kept in the description instead of becoming an enum', () => {
    const fld = green(load('title: T\nresources: [{name: x, fields: [{name: level, type: integer, enum: [1, 2, 3]}]}]\n').task).resources[0]?.fields[0];
    expect(fld).toMatchObject({ type: 'integer', description: 'one of 1|2|3' });
  });
});

describe('operations and endpoints', () => {
  it.each([
    ['[list, get, create, update, delete]', ['list', 'get', 'create', 'update', 'delete']],
    ['crud', ['list', 'get', 'create', 'update', 'delete']],
    ['[create, read, update, delete]', ['list', 'get', 'create', 'update', 'delete']],
    ['"index, show, add"', ['list', 'get', 'create']],
    ['[fetch, patch, remove]', ['get', 'update', 'delete']],
    ['{list: true, delete: false, create: yes}', ['list', 'create']],
    ['[read-only]', ['list', 'get']],
  ])('operations %s', (ops, want) => {
    expect(green(load(`title: T\nresources: [{name: x, fields: {a: string}, operations: ${ops}}]\n`).task).resources[0]?.operations).toEqual(want);
  });

  it('an unknown operation becomes a resource note (with a note), not an error', () => {
    const r = load('title: T\nresources: [{name: project, fields: {a: string}, operations: [list, archive]}]\n');
    expect(green(r.task).resources[0]).toMatchObject({ operations: ['list'], notes: ['operation: archive'] });
  });

  it.each([
    ['list of strings', '["GET /v1/todos", "POST /v1/todos", "GET /v1/todos/{todoId}"]'],
    ['objects with method/path', '[{method: GET, path: /todos}, {method: post, path: /todos}, {method: GET, path: "/todos/:id"}]'],
    ['OpenAPI-like map', '{"/todos": {get: list todos, post: create a todo}, "/todos/{id}": {get: one todo}}'],
  ])('resource endpoints (%s) -> operations, each kept verbatim as a behaviour', (_label, eps) => {
    const t = green(load(`title: T\nresources: [{name: todo, fields: {a: string}, endpoints: ${eps}}]\n`).task);
    expect(t.resources[0]?.operations).toEqual(['list', 'get', 'create']);
    expect(t.behaviours).toHaveLength(3);
    for (const b of t.behaviours) expect(b).toMatch(/^Endpoint: (GET|POST) \//i);
  });

  it('top-level endpoints are attributed to resources by path; custom routes stay behaviours', () => {
    const t = green(load('title: T\nresources: {user: {email: email}, team: {name: string}}\nendpoints:\n  - GET /api/v1/users\n  - DELETE /api/v1/users/:id\n  - POST /api/v1/teams/:id/archive\n').task);
    expect(t.resources.find((r) => r.name === 'user')?.operations).toEqual(['list', 'delete']);
    expect(t.resources.find((r) => r.name === 'team')?.operations).toEqual(['list', 'get', 'create', 'update', 'delete']);
    expect(t.behaviours).toContain('Endpoint: POST /api/v1/teams/:id/archive');
  });
});

describe('behaviours, brief and carried keys', () => {
  it.each([
    ['list', 'behaviours:\n  - a returns 201\n  - b returns 404\n'],
    ['bulleted string', 'behaviors: |\n  - a returns 201\n  - b returns 404\n'],
    ['numbered string', 'acceptance_criteria: |\n  1. a returns 201\n  2. b returns 404\n'],
    ['star bullets with a continuation line', 'requirements: |\n  * a returns\n    201\n  * b returns 404\n'],
    ['map', 'scenarios:\n  a: returns 201\n  b: returns 404\n'],
  ])('behaviours as %s', (label, body) => {
    const b = load(`title: T\nbrief: x\n${body}`).task.behaviours;
    expect(b).toHaveLength(2);
    expect(b.join('|')).toMatch(label === 'map' ? /a: returns 201\|b: returns 404/ : /a returns 201\|b returns 404/);
  });

  it.each(['brief', 'description', 'prompt', 'task', 'goal', 'overview', 'details', 'spec', 'instructions', 'request'])('free text under "%s:" is the brief', (key) => {
    const t = load(`title: T\n${key}: Build a library API with loans.\n`).task;
    expect(t.brief).toBe('Build a library API with loans.');
  });

  it('several brief keys are joined in priority order; multi-line text is kept verbatim', () => {
    const t = load('title: T\noverview: Second.\ndescription: |\n  First line.\n    indented line\n').task;
    expect(t.brief).toBe('First line.\n  indented line\n\nSecond.');
  });

  it('unknown top-level keys are carried verbatim (any value shape) with a note each', () => {
    const r = load('title: T\nbrief: x\nnotes: Use cursor pagination.\nauth: {type: bearer, scopes: [read, write]}\nnonFunctional: [p95 < 200ms]\n');
    expect(r.task.carried).toEqual({ notes: 'Use cursor pagination.', auth: { type: 'bearer', scopes: ['read', 'write'] }, nonFunctional: ['p95 < 200ms'] });
    expect(r.warnings.filter((w) => /carried to the model verbatim/.test(w))).toHaveLength(3);
  });

  it('markdown front matter supplies keys; the body is the brief (here: a brownfield change)', () => {
    const r = load('---\nkind: brownfield\nid: add-search\n---\n# Add search\n\nGET /v1/items accepts ?q=.\n', 'search.md');
    const t = brown(r.task);
    expect(t).toMatchObject({ id: 'add-search', title: 'Add search', target: '.' });
    expect(t.change).toBe('# Add search\n\nGET /v1/items accepts ?q=.');
  });

  it('brownfield: change and description are combined; acceptance criteria alone imply the change', () => {
    expect(brown(load('kind: brownfield\ntitle: T\nchange: Add X.\ndescription: Context.\n').task).change).toBe('Add X.\n\nContext.');
    const r = load('kind: brownfield\ntitle: T\nacceptance:\n  - DELETE /v1/x/{id} returns 204\n');
    expect(brown(r.task).change).toMatch(/acceptance criteri/);
    expect(r.warnings.join('\n')).toMatch(/change inferred from the acceptance criteria/);
  });

  it('greenfield: "change" text goes into the brief; scope/allowBreaking are carried (no effect) with a note', () => {
    const r = load('kind: greenfield\ntitle: T\nchange: Build X.\nresources: [x]\nscope: [src/**]\n');
    expect(r.task.brief).toBe('Build X.');
    expect(r.task.carried).toEqual({ scope: ['src/**'] });
  });

  it('brownfield extras: scope aliases, string booleans, resources to add', () => {
    const t = brown(load('kind: brownfield\ntitle: T\nchange: Add tags.\nscope: {include: "src/**/*.ts, test/**/*.ts", exclude: [src/legacy/**]}\nallow_breaking: "yes"\nresources: {tag: {label: string}}\n').task);
    expect(t.scope).toEqual({ allow: ['src/**/*.ts', 'test/**/*.ts'], deny: ['src/legacy/**'] });
    expect(t.allowBreaking).toBe(true);
    expect(t.resources?.[0]).toMatchObject({ name: 'tag', fields: [f('label', 'string')] });
  });

  it('id: file name first, then the title; title: heading, first sentence, else the id', () => {
    expect(load('brief: Build a library API.', 'library-api.task.yaml').task).toMatchObject({ id: 'library-api', title: 'Build a library API' });
    expect(load('brief: x', 'Orders Service.yml').task.id).toBe('orders-service');
    expect(load('brief: x', '...yaml').task).toMatchObject({ id: 'x', title: 'x' });
    expect(load('brief: "!!!"', '__.yaml').task).toMatchObject({ id: 'task', title: 'task' });
    expect(load('{"resources": ["thing"]}', 'my_task.json').task.title).toBe('my task');
  });

  it('limits: aliases and numeric strings; unknown limits are reported, not silently used', () => {
    const r = load('title: T\nbrief: x\nlimits: {max_turns: "12", maxTokens: 4000, timeout: 10m}\n');
    expect(r.task.limits).toEqual({ maxTurns: 12, maxOutputTokens: 4000 });
    expect(r.warnings.join('\n')).toMatch(/limits\.timeout: ignored/);
  });

  it('basePath and template are normalized (noted)', () => {
    const t = green(load('title: T\nbrief: x\nprefix: api/v2/\ntemplate: Express-Zod\n').task);
    expect(t.basePath).toBe('/api/v2');
    expect(t.template).toBe('express-zod');
  });
});

describe('provider keys are always an error (never inside resources or fields)', () => {
  const OK = 'title: T\nbrief: x\n';
  it.each([
    ['model: some-model'],
    ['Model: some-model'],
    ['models: [a, b]'],
    ['model: {name: some-model, temperature: 0}'],
    ['provider: acme'],
    ['driver: scripted'],
    ['llm: {name: x}'],
    ['temperature: 0.2'],
    ['api_key: sk-123'],
    ['apiKey: sk-123'],
    ['ACME_API_KEY: sk-123'],
    ['model_name: x'],
    ['limits: {maxTurns: 5, model: x}'],
    ['options: {provider: acme}'],
    ['settings: {temperature: 1}'],
    ['config: {api-key: k}'],
  ])('%s', (line) => {
    for (const strict of [false, true]) {
      const body = strict ? `kind: greenfield\nid: t\ntitle: T\noutput: o\nbrief: x\n${line}\n` : `${OK}${line}\n`;
      expect(loadErr(body, 'p.task.yaml', { strict })).toMatch(/key "[^"]+" is not allowed: task files are provider-neutral/);
    }
  });

  it('fields and resources named model/provider/driver/temperature load (they are data, not settings)', () => {
    const t = green(load('title: Rentals\nresources:\n  car: {make: string, model: string, provider: string}\n  driver: {name: string, licence: string}\n  sensor: {temperature: decimal}\n').task);
    expect(t.resources.map((r) => r.name)).toEqual(['car', 'driver', 'sensor']);
    expect(t.resources[0]?.fields.map((x) => x.name)).toEqual(['make', 'model', 'provider']);
    expect(t.resources[2]?.fields[0]).toMatchObject(f('temperature', 'decimal'));
  });
});

describe('what must stay an error, all reported in one pass', () => {
  it.each([
    ['malformed YAML', 'title: [unclosed\n', 'x.yaml', /cannot parse|unexpected|flow|Missing|end/i],
    ['malformed JSON', '{"title": "T",}', 'x.json', /JSON|Unexpected|Expected/],
    ['empty file', '  \n', 'x.yaml', /empty/],
    ['only comments', '# nothing\n', 'x.yaml', /no content/],
    ['a YAML list', '- a\n- b\n', 'x.yaml', /must be a mapping of keys or free text/],
    ['enum without values', 'title: T\nresources: [{name: x, fields: [{name: s, type: enum}]}]\n', 'x.yaml', /enum fields need "values"/],
    ['default not in values', 'title: T\nresources: [{name: x, fields: [{name: s, values: [a, b], default: c}]}]\n', 'x.yaml', /default "c" is not one of values/],
    ['min > max', 'title: T\nresources: [{name: x, fields: [{name: n, type: integer, min: 5, max: 1}]}]\n', 'x.yaml', /min must be <= max/],
    ['duplicate fields after normalization', 'title: T\nresources: [{name: x, fields: {email: email, Email: string}}]\n', 'x.yaml', /duplicate field "Email"/],
    ['".." in a path', 'kind: brownfield\ntitle: T\ntarget: ../api\nchange: x\n', 'x.yaml', /must not contain "\.\."/],
    ['greenfield with neither resources nor a brief', 'kind: greenfield\ntitle: T\n', 'x.yaml', /needs resources or a brief/],
    ['brownfield with no change and no acceptance criteria', 'kind: brownfield\ntitle: T\ntarget: .\n', 'x.yaml', /needs a change/],
    ['brief over the cap', `title: T\nbrief: "${'a'.repeat(MAX_BRIEF_CHARS + 1)}"\n`, 'x.yaml', /longer than 32000 characters/],
    ['resource name that cannot be a noun', 'title: T\nresources: [{name: "123", fields: {a: string}}]\n', 'x.yaml', /lower-case singular noun/],
  ])('%s', (_label, body, name, msg) => {
    expect(() => load(body, name)).toThrow(msg);
  });

  it('every issue is listed at once (not one per edit round)', () => {
    const msg = loadErr(
      'kind: greenfield\ntitle: T\nmodel: x\ntarget: ../a\nresources:\n  - name: x\n    fields:\n      - {name: s, type: enum}\n      - {name: n, type: integer, min: 9, max: 1}\n',
    );
    for (const m of [/key "model"/, /names an existing API/, /enum fields need "values"/, /min must be <= max/]) expect(msg).toMatch(m);
    expect(msg.split('\n').length).toBeGreaterThanOrEqual(5);
  });

  it('--strict-task: a missing kind does not hide the other issues', () => {
    const msg = loadErr('id: Bad_Id\ntitle: T\ntarget: a\nchange: c\nextra: 1\n', 'x.yaml', { strict: true });
    expect(msg).toMatch(/kind: must be "greenfield"/);
    expect(msg).toMatch(/id must match/);
    expect(msg).toMatch(/unknown key "extra"/);
  });
});

describe('CLI overrides and determinism', () => {
  it('--target decides brownfield and wins over the file; --output decides greenfield', () => {
    const r = load('title: T\ndescription: Add search.\n', 'x.yaml', { target: '/abs/their-api' });
    expect(brown(r.task)).toMatchObject({ target: '/abs/their-api', change: 'Add search.' });
    expect(r.warnings.join('\n')).toMatch(/target set by --target/);
    expect(green(load('title: T\nbrief: x\noutput: a/b\n', 'x.yaml', { output: '/abs/out' }).task).output).toBe('/abs/out');
    expect(loadErr('kind: greenfield\ntitle: T\nbrief: x\n', 'x.yaml', { target: '/abs/api' })).toMatch(/--target names an existing API/);
    expect(loadErr('kind: brownfield\ntitle: T\nchange: x\n', 'x.yaml', { output: '/abs/out' })).toMatch(/--output names a new output directory/);
  });

  it('the same file always normalizes to the same task (and key order does not matter)', () => {
    const body = 'title: Shop\nresources:\n  customer: {name: string, email: email}\n  order: {total: decimal, status: "pending|paid"}\nbehaviours: [a, b]\nnotes: n\n';
    const a = load(body);
    const b = load(body);
    expect(a).toEqual(b);
    const reordered = stringifyYaml({ notes: 'n', behaviours: ['a', 'b'], resources: { customer: { name: 'string', email: 'email' }, order: { total: 'decimal', status: 'pending|paid' } }, title: 'Shop' });
    expect(normalizedSha256(load(reordered).task)).toBe(normalizedSha256(a.task));
  });
});
