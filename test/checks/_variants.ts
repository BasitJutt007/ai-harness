/**
 * Variant APIs: realistic ways different models write the users API on top of the
 * greenfield template. A variant directory under test/fixtures/apis/variants/<name>/
 * holds only the files the agent would write (routes, schemas, stores, …); it is
 * assembled onto a copy of templates/express-zod (package.json, tsconfig.json,
 * src/app.ts, src/server.ts, src/lib/**) inside .harness/tmp so node_modules
 * resolve from the harness root, exactly like a generated API.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import problemJson from '../../plugins/checks/problem-json.ts';
import restConventions from '../../plugins/checks/rest-conventions.ts';
import tscStrict from '../../plugins/checks/tsc-strict.ts';
import zodBoundary from '../../plugins/checks/zod-boundary.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import type { CheckPlugin } from '../../src/core/plugin-api.ts';
import { FIXTURES } from './_ctx.ts';

export const STANDARD_CHECKS: CheckPlugin[] = [zodBoundary, problemJson, tscStrict, restConventions];

export const VARIANTS = join(FIXTURES, 'variants');
export const TEMPLATE = join(HARNESS_ROOT, 'templates', 'express-zod');

export function variantNames(prefix: string): string[] {
  return readdirSync(VARIANTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
    .map((d) => d.name)
    .sort();
}

/** Template files a generated API starts from (its own tests are not copied: they do not affect the checks). */
const TEMPLATE_FILES = ['package.json', 'tsconfig.json', 'src/app.ts', 'src/server.ts', 'src/lib', 'src/routes/index.ts'];

export async function assembleVariant(name: string): Promise<string> {
  const root = join(HARNESS_ROOT, '.harness', 'tmp', `variant-${name}-${process.pid}-${randomBytes(4).toString('hex')}`);
  await mkdir(join(root, 'src', 'routes'), { recursive: true });
  for (const rel of TEMPLATE_FILES) await cp(join(TEMPLATE, rel), join(root, rel), { recursive: true });
  await cp(join(VARIANTS, name), root, { recursive: true });
  return root;
}

export async function removeVariant(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
