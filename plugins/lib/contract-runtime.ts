/**
 * Contract runtime (spawned with tsx by contract.ts):
 *   tsx contract-runtime.ts <apiRoot> <refs.json>
 * refs.json = Array<{ module: string /* API-relative *\/; exportName: string }>.
 *
 * Imports each module, takes the export and converts it to JSON Schema: io 'input' (what a
 * request accepts) and io 'output' (what a response emits). The converter is picked per
 * schema by the Zod major that built it: a Zod 4 schema (`_zod`) with Zod 4's toJSONSchema
 * (the API's own zod, its `zod/v4` subpath on a 3.x install, else the harness's); a Zod 3
 * schema (`_def` only) with zod-to-json-schema resolved from the API root, or an error that
 * says exactly that (the contract then falls back to source text: UNPROVEN on change).
 * Prints exactly one result line starting with {"contractRuntime":1, then exits.
 * Runs inside the OS sandbox (contract.ts passes the policy) and is only handed modules whose import
 * closure is unchanged since the base commit or declarative Zod (schema-purity.ts): agent code that
 * could fake the measurement is never imported here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z as harnessZ } from 'zod';

type ToJson = (schema: unknown, opts: Record<string, unknown>) => unknown;
/** A fresh, empty metadata registry of the same zod instance (see convert()). */
type NewRegistry = () => unknown;

interface SchemaResult {
  module: string;
  exportName: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function zodFrom(mod: unknown): { toJson: ToJson; registry: NewRegistry } | undefined {
  if (!isRecord(mod)) return undefined;
  const candidates: unknown[] = [mod, mod.z, mod.default];
  for (const c of candidates) {
    if (!isRecord(c)) continue;
    const fn = c.toJSONSchema;
    const reg = c.registry;
    if (typeof fn === 'function' && typeof reg === 'function') {
      return {
        toJson: (schema, opts) => {
          const out: unknown = Reflect.apply(fn, undefined, [schema, opts]);
          return out;
        },
        registry: () => {
          const out: unknown = Reflect.apply(reg, undefined, []);
          return out;
        },
      };
    }
  }
  return undefined;
}

/** package.json of `name` as resolved from the API root (walking up from its resolved entry), or undefined. */
function findPackage(apiRoot: string, name: string): { dir: string; manifest: Record<string, unknown> } | undefined {
  try {
    const req = createRequire(join(apiRoot, 'package.json'));
    let dir = dirname(req.resolve(name));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
        if (isRecord(pkg) && pkg.name === name) return { dir, manifest: pkg };
      }
      dir = dirname(dir);
    }
  } catch {
    // not resolvable from the API root
  }
  return undefined;
}

/** The ESM entry of a package subpath ('.', './v4'): the file the API's own `import` loads. */
function esmEntry(pkg: { dir: string; manifest: Record<string, unknown> }, subpath: string): string | undefined {
  const exp = pkg.manifest.exports;
  const pick = (v: unknown): string | undefined => (typeof v === 'string' ? v : isRecord(v) ? pick(v.import) ?? pick(v.default) : undefined);
  let entry: string | undefined;
  if (isRecord(exp)) entry = pick(exp[subpath]);
  else if (subpath === '.') entry = typeof pkg.manifest.module === 'string' ? pkg.manifest.module : typeof pkg.manifest.main === 'string' ? pkg.manifest.main : 'index.js';
  if (entry === undefined) return undefined;
  const abs = join(pkg.dir, entry);
  return existsSync(abs) ? abs : undefined;
}

interface Zod4 {
  toJson: ToJson;
  registry: NewRegistry;
  source: string;
}

/** Converts a Zod 3 schema (zod-to-json-schema's `zodToJsonSchema`). */
type Zod3Convert = (schema: unknown, io: 'input' | 'output') => unknown;

interface Converters {
  /** Zod 4 conversion: the API's own zod (or its zod/v4 subpath), else the harness's. */
  v4: Zod4;
  /** Zod 3 conversion, or the reason there is none. */
  v3: Zod3Convert | string;
  /** Installed zod version of the API (null when it has none). */
  version: string | null;
}

const HARNESS_ZOD4: Zod4 = {
  toJson: (schema, opts) => {
    const out: unknown = Reflect.apply(harnessZ.toJSONSchema, undefined, [schema, opts]);
    return out;
  },
  registry: () => harnessZ.registry(),
  source: 'harness',
};

/** Find the API's zod and pick a converter per major (see the module comment). */
async function loadConverters(apiRoot: string): Promise<Converters> {
  const zodPkg = findPackage(apiRoot, 'zod');
  const version = zodPkg !== undefined && typeof zodPkg.manifest.version === 'string' ? zodPkg.manifest.version : null;
  let v4: Zod4 = HARNESS_ZOD4;
  if (zodPkg !== undefined) {
    // Zod 4 exports toJSONSchema from its main entry; a 3.25+ install carries Zod 4 at zod/v4.
    for (const sub of ['.', './v4']) {
      const entry = esmEntry(zodPkg, sub);
      if (entry === undefined) continue;
      try {
        const found = zodFrom(await import(pathToFileURL(entry).href));
        if (found !== undefined) {
          v4 = { ...found, source: join(zodPkg.dir, 'package.json') };
          break;
        }
      } catch {
        // try the next entry
      }
    }
  }
  let v3: Zod3Convert | string = 'zod 3 schemas need zod-to-json-schema (not resolvable from the API root)';
  const zjs = findPackage(apiRoot, 'zod-to-json-schema');
  const zjsEntry = zjs === undefined ? undefined : esmEntry(zjs, '.');
  if (zjsEntry !== undefined) {
    try {
      const mod: unknown = await import(pathToFileURL(zjsEntry).href);
      const fn = isRecord(mod) ? mod.zodToJsonSchema ?? mod.default : undefined;
      if (typeof fn === 'function') {
        v3 = (schema, io) => {
          const opts = { target: 'jsonSchema7', $refStrategy: 'none', effectStrategy: io === 'input' ? 'input' : 'any', pipeStrategy: io };
          const out: unknown = Reflect.apply(fn, undefined, [schema, opts]);
          return out;
        };
      } else {
        v3 = 'zod 3 schemas need zod-to-json-schema (the installed package exports no zodToJsonSchema)';
      }
    } catch (e) {
      v3 = `zod 3 schemas need zod-to-json-schema (it failed to load: ${errMsg(e).split('\n')[0] ?? ''})`;
    }
  }
  return { v4, v3, version };
}

function parseRefs(file: string): Array<{ module: string; exportName: string }> {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('refs file must be a JSON array');
  const refs: Array<{ module: string; exportName: string }> = [];
  for (const r of raw) {
    if (isRecord(r) && typeof r.module === 'string' && typeof r.exportName === 'string') {
      refs.push({ module: r.module, exportName: r.exportName });
    }
  }
  return refs;
}

/**
 * JSON Schema of `schema` as accepted (io 'input') or emitted (io 'output'). The metadata registry is a
 * fresh empty one: `.meta({ enum: [...] })` would otherwise be merged into the output and let a schema
 * describe itself wider than it parses.
 */
function convert(zod: Converters, schema: Record<string, unknown>, io: 'input' | 'output'): Record<string, unknown> {
  let out: unknown;
  if ('_zod' in schema) {
    out = zod.v4.toJson(schema, { io, unrepresentable: 'any', metadata: zod.v4.registry() });
  } else {
    // A Zod 3 schema (`_def` only): Zod 4's converter cannot read it.
    if (typeof zod.v3 === 'string') throw new Error(zod.v3);
    out = zod.v3(schema, io);
  }
  if (!isRecord(out)) throw new Error('conversion did not return an object');
  const copy: Record<string, unknown> = { ...out };
  delete copy.$schema;
  return copy;
}

async function main(argv: string[]): Promise<void> {
  const [apiRootArg, refsFile] = argv;
  if (apiRootArg === undefined || refsFile === undefined) throw new Error('usage: contract-runtime <apiRoot> <refs.json>');
  const apiRoot = resolve(apiRootArg);
  const refs = parseRefs(refsFile);
  const zod = await loadConverters(apiRoot);
  const modules = new Map<string, Promise<unknown>>();
  const schemas: SchemaResult[] = [];
  for (const ref of refs) {
    const result: SchemaResult = { module: ref.module, exportName: ref.exportName };
    try {
      const abs = resolve(apiRoot, ref.module);
      let pending = modules.get(abs);
      if (pending === undefined) {
        pending = import(pathToFileURL(abs).href);
        modules.set(abs, pending);
      }
      const mod = await pending;
      const schema = isRecord(mod) ? mod[ref.exportName] : undefined;
      if (!isRecord(schema) || !('_zod' in schema || '_def' in schema)) {
        throw new Error(`export ${ref.exportName} of ${ref.module} is not a Zod schema`);
      }
      result.input = convert(zod, schema, 'input');
      result.output = convert(zod, schema, 'output');
    } catch (e) {
      result.error = errMsg(e).split('\n')[0] ?? 'error';
    }
    schemas.push(result);
  }
  process.stdout.write(`${JSON.stringify({ contractRuntime: 1, ok: true, zod: zod.v4.source === 'harness' ? 'harness' : 'api', zodVersion: zod.version, schemas })}\n`);
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (e: unknown) => {
    process.stdout.write(`${JSON.stringify({ contractRuntime: 1, ok: false, error: errMsg(e), schemas: [] })}\n`);
    process.exit(1);
  },
);
