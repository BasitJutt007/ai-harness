/**
 * Contract runtime (spawned with tsx by contract.ts):
 *   tsx contract-runtime.ts <apiRoot> <refs.json>
 * refs.json = Array<{ module: string /* API-relative *\/; exportName: string }>.
 *
 * Imports each module, takes the export and converts it with Zod 4's JSON Schema
 * conversion: io 'input' (what a request accepts) and io 'output' (what a
 * response emits). Zod is resolved from the API root so the API's own zod
 * instance does the conversion; the harness's zod is the fallback.
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

/** Find the API's zod package and import its ESM entry (the one the API's own modules load). */
async function loadZod(apiRoot: string): Promise<{ toJson: ToJson; registry: NewRegistry; source: string }> {
  try {
    const req = createRequire(join(apiRoot, 'package.json'));
    let dir = dirname(req.resolve('zod'));
    let pkgFile: string | undefined;
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
        if (isRecord(pkg) && pkg.name === 'zod') {
          pkgFile = candidate;
          break;
        }
      }
      dir = dirname(dir);
    }
    if (pkgFile !== undefined) {
      const pkg: unknown = JSON.parse(readFileSync(pkgFile, 'utf8'));
      let entry = 'index.js';
      if (isRecord(pkg) && isRecord(pkg.exports)) {
        const dot = pkg.exports['.'];
        if (isRecord(dot) && typeof dot.import === 'string') entry = dot.import;
        else if (isRecord(dot) && isRecord(dot.import) && typeof dot.import.default === 'string') entry = dot.import.default;
      } else if (isRecord(pkg) && typeof pkg.module === 'string') {
        entry = pkg.module;
      }
      const mod: unknown = await import(pathToFileURL(join(dirname(pkgFile), entry)).href);
      const found = zodFrom(mod);
      if (found !== undefined) return { ...found, source: pkgFile };
    }
  } catch {
    // fall through to the harness's zod
  }
  return {
    toJson: (schema, opts) => {
      const out: unknown = Reflect.apply(harnessZ.toJSONSchema, undefined, [schema, opts]);
      return out;
    },
    registry: () => harnessZ.registry(),
    source: 'harness',
  };
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
function convert(zod: { toJson: ToJson; registry: NewRegistry }, schema: unknown, io: 'input' | 'output'): Record<string, unknown> {
  const out = zod.toJson(schema, { io, unrepresentable: 'any', metadata: zod.registry() });
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
  const zod = await loadZod(apiRoot);
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
  process.stdout.write(`${JSON.stringify({ contractRuntime: 1, ok: true, zod: zod.source === 'harness' ? 'harness' : 'api', schemas })}\n`);
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (e: unknown) => {
    process.stdout.write(`${JSON.stringify({ contractRuntime: 1, ok: false, error: errMsg(e), schemas: [] })}\n`);
    process.exit(1);
  },
);
