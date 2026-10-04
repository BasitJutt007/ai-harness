/**
 * Foreign API styles: five compliant Express + Zod APIs written in styles other than our
 * template (validate() middleware, controller/service + domain errors, an exported app
 * instance, route constants + nested routers, asyncHandler + HttpError). Each lives under
 * test/fixtures/apis/styles/<name>/; a test copies one into .harness/tmp (so node_modules
 * resolve from the harness root) and applies exact text edits to make a variant or plant
 * one violation. The static checks run without starting the app.
 */
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import problemJson, { staticProblemFindings } from '../../plugins/checks/problem-json.ts';
import restConventions from '../../plugins/checks/rest-conventions.ts';
import zodBoundary from '../../plugins/checks/zod-boundary.ts';
import { formatReport } from '../../src/core/checks.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import type { CheckFinding } from '../../src/core/plugin-api.ts';
import { FIXTURES, contextFor } from './_ctx.ts';

export const STYLES = join(FIXTURES, 'styles');
export const STYLE_NAMES = ['a-validate-mw', 'b-controller-service', 'c-app-instance', 'd-route-consts', 'e-asynchandler-httperror'] as const;
export type StyleName = (typeof STYLE_NAMES)[number];

/** Per file: whole new content, or exact [from, to] replacements (each `from` must occur). */
export type Edits = Record<string, string | Array<[string, string]>>;

export async function styleCopy(name: StyleName, edits: Edits = {}): Promise<string> {
  const root = join(HARNESS_ROOT, '.harness', 'tmp', `style-${name}-${process.pid}-${randomBytes(5).toString('hex')}`);
  await mkdir(root, { recursive: true });
  await cp(join(STYLES, name), root, { recursive: true });
  for (const [rel, edit] of Object.entries(edits)) {
    const file = join(root, rel);
    if (typeof edit === 'string') {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, edit, 'utf8');
      continue;
    }
    let text = await readFile(file, 'utf8');
    for (const [from, to] of edit) {
      if (!text.includes(from)) throw new Error(`${name}/${rel}: edit target not found: ${from}`);
      text = text.replace(from, to);
    }
    await writeFile(file, text, 'utf8');
  }
  return root;
}

export async function removeStyle(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export const STATIC_CHECKS = [zodBoundary, restConventions, problemJson];

/** zod-boundary + rest-conventions + the static part of problem-json (the app is not started). */
export async function staticFindings(root: string): Promise<{ findings: CheckFinding[]; report: ReturnType<typeof formatReport> }> {
  const ctx = await contextFor(root);
  const findings = [...(await zodBoundary.run(ctx)), ...(await restConventions.run(ctx)), ...staticProblemFindings(ctx)];
  return { findings, report: formatReport(findings, STATIC_CHECKS, root) };
}

/** 1-based line of `needle` (may span lines) in a file of a style copy. */
export async function lineIn(root: string, rel: string, needle: string): Promise<number> {
  const text = await readFile(join(root, rel), 'utf8');
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`"${needle}" not found in ${rel}`);
  return text.slice(0, at).split('\n').length;
}
