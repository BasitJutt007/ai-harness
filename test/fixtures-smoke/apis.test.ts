/**
 * The greenfield template and the brownfield sample are real, green, strictly typed APIs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findUnsafeCode } from '../../plugins/lib/ts-safety.ts';
import { ROOT, providerHits, tsc, vitest, walk } from './helpers.ts';

const TEMPLATE = join(ROOT, 'templates', 'express-zod');
const SAMPLE = join(ROOT, 'samples', 'existing-api');

const PackageSchema = z.object({
  name: z.string(),
  type: z.literal('module'),
  scripts: z.record(z.string(), z.string()),
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
});

function readPackage(dir: string) {
  return PackageSchema.parse(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
}

const rootPkg = readPackage(ROOT);
const rootVersions: Record<string, string> = { ...rootPkg.dependencies, ...rootPkg.devDependencies };

/** Hand-written DTO shapes are banned under src/ (zod-boundary): types must come from z.infer. */
const HAND_WRITTEN_TYPE = /^\s*(export\s+)?(interface\s+\w+|type\s+\w+(<[^>]*>)?\s*=\s*\{)/m;

function sourceChecks(dir: string): void {
  const files = walk(dir).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    expect(findUnsafeCode(file, text), `${file} has unsafe code`).toEqual([]);
    expect(providerHits(text), `${file} names a model provider`).toEqual([]);
    if (file.startsWith('src/')) expect(text, `${file} hand-writes a type`).not.toMatch(HAND_WRITTEN_TYPE);
  }
}

describe.each([
  ['templates/express-zod', TEMPLATE],
  ['samples/existing-api', SAMPLE],
])('%s', (_label, dir) => {
  it('pins dependency versions to the harness root package.json', () => {
    const pkg = readPackage(dir);
    expect(pkg.scripts).toMatchObject({ test: 'vitest run', typecheck: 'tsc --noEmit', start: 'tsx src/server.ts' });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['express', 'zod']);
    for (const name of ['vitest', 'supertest', 'typescript', '@types/express', '@types/supertest', '@types/node', 'tsx']) {
      expect(Object.keys(pkg.devDependencies)).toContain(name);
    }
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toBe(rootVersions[name]);
    }
  });

  it('has no any / non-null assertions / ts directives, no hand-written types, no provider names', () => {
    sourceChecks(dir);
  });

  it('exports createApp from src/app.ts and has the lib modules', () => {
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toMatch(/export function createApp\(\): Express/);
    for (const lib of ['problem', 'errors', 'pagination', 'idempotency']) {
      expect(walk(dir)).toContain(`src/lib/${lib}.ts`);
    }
  });

  it('its own test suite is green', () => {
    const report = vitest(dir);
    expect(report.numFailedTests, report.output).toBe(0);
    expect(report.numTotalTests).toBeGreaterThan(10);
  });

  it('type-checks cleanly under strict + noUncheckedIndexedAccess', () => {
    const res = tsc(dir);
    expect(res.output.trim(), res.output).toBe('');
    expect(res.code).toBe(0);
  });
});

describe('template specifics', () => {
  it('uses the __API_NAME__ placeholder and an empty registerRoutes', () => {
    expect(readPackage(TEMPLATE).name).toBe('__API_NAME__');
    const routes = readFileSync(join(TEMPLATE, 'src/routes/index.ts'), 'utf8');
    expect(routes).toMatch(/export function registerRoutes\(app: Router\): void/);
    expect(routes).not.toMatch(/^\s*app\.use\(/m);
  });

  it('ships lib tests for 404, 400, 422, cursors and idempotency', () => {
    const tests = walk(join(TEMPLATE, 'test'));
    expect(tests).toEqual(expect.arrayContaining(['lib/errors.test.ts', 'lib/pagination.test.ts', 'lib/idempotency.test.ts']));
  });
});

describe('sample specifics', () => {
  it('has the projects module and no delete route or status filter yet', () => {
    const routes = readFileSync(join(SAMPLE, 'src/modules/projects/routes.ts'), 'utf8');
    expect(routes).not.toMatch(/\.delete\(/);
    const schema = readFileSync(join(SAMPLE, 'src/modules/projects/schema.ts'), 'utf8');
    expect(schema).toMatch(/export const ListProjectsQuerySchema = CursorQuerySchema;/);
  });
});
