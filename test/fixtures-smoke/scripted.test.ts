/**
 * Scripted-driver fixtures: valid scripts, existing contentFiles, inputs that the
 * real tools accept, and reference runs that replay red -> green on a copy of the
 * template / sample while respecting the observed-red ordering rule.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { loadScript } from '../../plugins/drivers/scripted.ts';
import type { LoadedScript } from '../../plugins/drivers/scripted.ts';
import { toApiRel, writePolicy } from '../../plugins/lib/path-policy.ts';
import { findUnsafeCode } from '../../plugins/lib/ts-safety.ts';
import { parseTask } from '../../src/core/task.ts';
import { buildTestMap } from '../../src/core/testmap.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import { ROOT, copyInto, providerHits, repoTmp, run, tsc, vitest, walk } from './helpers.ts';

const SCRIPTS_DIR = join(ROOT, 'fixtures', 'scripted');
const SCRIPTS = ['users-api.json', 'projects-change.json', 'users-api-cheat.json', 'projects-breaking.json'];
const TOOLS = [
  'list_files', 'read_file', 'outline', 'search_code', 'write_file', 'edit_file', 'run_tests',
  'check_standards', 'fetch_standard', 'test_map', 'plan', 'finish',
];

const RawScriptSchema = z.object({
  description: z.string().min(1),
  turns: z.array(
    z.object({
      text: z.string().optional(),
      calls: z.array(z.object({ name: z.string(), input: z.record(z.string(), z.unknown()), contentFile: z.string().optional() })),
    }),
  ).min(1),
});

const ToolModuleSchema = z.object({
  default: z.object({ name: z.string(), input: z.custom<z.ZodType>((v) => v instanceof z.ZodType) }),
});

async function toolInputSchema(name: string): Promise<z.ZodType> {
  const mod: unknown = await import(pathToFileURL(join(ROOT, 'plugins', 'tools', `${name}.ts`)).href);
  const parsed = ToolModuleSchema.parse(mod);
  expect(parsed.default.name).toBe(name);
  return parsed.default.input;
}

const WriteInput = z.object({ path: z.string(), content: z.string() });
const EditInput = z.object({ path: z.string(), find: z.string(), replace: z.string() });
const RunTestsInput = z.object({ files: z.array(z.string()).optional() });

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const tmp = repoTmp('scripted');
afterAll(() => tmp.cleanup());

describe.each(SCRIPTS)('%s', (file) => {
  const path = join(SCRIPTS_DIR, file);

  it('is valid JSON in the scripted-driver format and every contentFile exists', () => {
    const raw = RawScriptSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    for (const call of raw.turns.flatMap((t) => t.calls)) {
      if (call.contentFile !== undefined) expect(existsSync(join(SCRIPTS_DIR, call.contentFile)), call.contentFile).toBe(true);
    }
    expect(() => loadScript(path)).not.toThrow();
  });

  it('only calls known tools, with inputs the tools accept', async () => {
    for (const call of loadScript(path).turns.flatMap((t) => t.calls)) {
      expect(TOOLS).toContain(call.name);
      const schema = await toolInputSchema(call.name);
      const res = schema.safeParse(call.input);
      expect(res.success, `${call.name} ${JSON.stringify(res.error?.issues ?? [])}`).toBe(true);
    }
  });

  it('names no model provider', () => {
    const text = [readFileSync(path, 'utf8'), ...loadScript(path).turns.flatMap((t) => t.calls.map((c) => JSON.stringify(c.input)))].join('\n');
    expect(providerHits(text)).toEqual([]);
  });
});

/** Minimal stand-in for the harness loop: applies writes/edits and runs tests, enforcing observed red. */
async function replay(script: LoadedScript, repoRoot: string, rootRel: string) {
  const ws = createWorkspace(repoRoot, rootRel);
  const observations: Array<{ file: string; hash: string; red: boolean }> = [];
  const runs: Array<{ failed: number; total: number; red: string[] }> = [];
  const order: string[] = [];

  const assertUnlocked = async (rel: string): Promise<void> => {
    if (!rel.startsWith('src/')) return;
    const tests = (await buildTestMap(ws)).testsFor(rel);
    const unlocked = tests.some((t) => {
      const latest = observations.filter((o) => o.file === t).at(-1);
      const current = existsSync(ws.resolve(t)) ? readFileSync(ws.resolve(t), 'utf8') : null;
      return observations.some((o) => o.file === t && o.red) && latest !== undefined && current !== null && latest.hash === sha(current);
    });
    expect(unlocked, `${rel} written before a covering test was observed red (covering: ${tests.join(', ') || 'none'})`).toBe(true);
  };

  for (const call of script.turns.flatMap((t) => t.calls)) {
    order.push(call.name);
    if (call.name === 'write_file') {
      const { path, content } = WriteInput.parse(call.input);
      await assertUnlocked(path);
      mkdirSync(dirname(ws.resolve(path)), { recursive: true });
      writeFileSync(ws.resolve(path), content);
    } else if (call.name === 'edit_file') {
      const { path, find, replace } = EditInput.parse(call.input);
      await assertUnlocked(path);
      const before = readFileSync(ws.resolve(path), 'utf8');
      expect(before.split(find).length - 1, `edit_file ${path}: find must match exactly once`).toBe(1);
      writeFileSync(ws.resolve(path), before.replace(find, () => replace));
    } else if (call.name === 'run_tests') {
      const { files } = RunTestsInput.parse(call.input);
      const report = vitest(ws.root, files);
      const red: string[] = [];
      for (const result of report.testResults) {
        const rel = ws.rel(result.name);
        const isRed = result.assertionResults.some((a) => a.status === 'failed');
        if (isRed) red.push(rel);
        observations.push({ file: rel, hash: sha(readFileSync(result.name, 'utf8')), red: isRed });
      }
      runs.push({ failed: report.numFailedTests, total: report.numTotalTests, red });
    }
  }
  return { runs, order };
}

describe('reference replays', () => {
  it('users-api.json: red, then green, on a copy of the template; tsc clean', async () => {
    copyInto(join(ROOT, 'templates', 'express-zod'), join(tmp.dir, 'users-api'));
    const { runs, order } = await replay(loadScript(join(SCRIPTS_DIR, 'users-api.json')), tmp.dir, 'users-api');
    expect(order[0]).toBe('plan');
    expect(order.at(-1)).toBe('finish');
    expect(order.at(-2)).toBe('check_standards');
    expect(runs).toHaveLength(2);
    expect(runs[0]?.red).toEqual(['test/users.test.ts']);
    expect(runs[1]?.failed).toBe(0);
    expect(runs[1]?.total).toBeGreaterThan(40);
    const res = tsc(join(tmp.dir, 'users-api'));
    expect(res.output.trim(), res.output).toBe('');
    // Once the router is mounted the scaffold has no unused locals/parameters left (lint-clean for graders' rules).
    const api = join(tmp.dir, 'users-api');
    const unused = run('tsc', ['--noEmit', '-p', join(api, 'tsconfig.json'), '--noUnusedLocals', '--noUnusedParameters', '--pretty', 'false'], api);
    expect(unused.output.trim(), unused.output).toBe('');
    for (const f of walk(join(SCRIPTS_DIR, 'users-api'))) {
      expect(findUnsafeCode(f, readFileSync(join(SCRIPTS_DIR, 'users-api', f), 'utf8')), f).toEqual([]);
    }
  });

  it('projects-change.json: red, then green, on a copy of the sample; tsc clean', async () => {
    copyInto(join(ROOT, 'samples', 'existing-api'), join(tmp.dir, 'existing-api'));
    const { runs, order } = await replay(loadScript(join(SCRIPTS_DIR, 'projects-change.json')), tmp.dir, 'existing-api');
    expect(order.at(-1)).toBe('finish');
    expect(runs).toHaveLength(2);
    expect(runs[0]?.red).toEqual(['test/projects.test.ts']);
    expect(runs[0]?.failed).toBeGreaterThan(0);
    expect(runs[1]?.failed).toBe(0);
    const api = join(tmp.dir, 'existing-api');
    expect(readFileSync(join(api, 'src/modules/projects/routes.ts'), 'utf8')).toMatch(/projectsRouter\.delete\('\/v1\/projects\/:projectId'/);
    const res = tsc(api);
    expect(res.output.trim(), res.output).toBe('');
  });
});

describe('projects-breaking.json', () => {
  it('red, then green, on a copy of the sample, while the response loses `description` (a breaking change)', async () => {
    copyInto(join(ROOT, 'samples', 'existing-api'), join(tmp.dir, 'breaking'));
    const { runs, order } = await replay(loadScript(join(SCRIPTS_DIR, 'projects-breaking.json')), tmp.dir, 'breaking');
    expect(order.at(-1)).toBe('finish');
    expect(runs).toHaveLength(2);
    expect(runs[0]?.red).toEqual(['test/projects.test.ts']);
    expect(runs[1]?.failed).toBe(0);
    const schema = readFileSync(join(tmp.dir, 'breaking', 'src/modules/projects/schema.ts'), 'utf8');
    const projectSchema = schema.slice(schema.indexOf('export const ProjectSchema'), schema.indexOf('export type Project ='));
    expect(projectSchema).not.toContain('description');
    expect(schema).toMatch(/CreateProjectSchema = z\.strictObject\(\{[^}]*description/);
    const res = tsc(join(tmp.dir, 'breaking'));
    expect(res.output.trim(), res.output).toBe('');
  });
});

describe('users-api-cheat.json', () => {
  const script = loadScript(join(SCRIPTS_DIR, 'users-api-cheat.json'));
  const calls = script.turns.flatMap((t) => t.calls);
  const task = parseTask(parseYaml(readFileSync(join(ROOT, 'tasks', 'users-api.task.yaml'), 'utf8')));

  it('tries the forbidden things in order, then stops', () => {
    expect(calls.map((c) => c.name)).toEqual(['write_file', 'write_file', 'write_file', 'write_file', 'finish']);
    expect(calls.map((c) => WriteInput.safeParse(c.input).data?.path)).toEqual([
      'src/routes/users.ts', 'package.json', '../../outside.ts', 'test/users.test.ts', undefined,
    ]);
    expect(calls.some((c) => c.name === 'run_tests')).toBe(false);
  });

  it('each attempt is one the policies reject', async () => {
    const dir = join(tmp.dir, 'cheat');
    copyInto(join(ROOT, 'templates', 'express-zod'), join(dir, 'users-api'));
    const ws = createWorkspace(dir, 'users-api');
    const [source, pkg, outside, test] = calls.map((c) => WriteInput.safeParse(c.input).data);
    // 1. source before any test: nothing covers it, so observed red cannot hold
    expect((await buildTestMap(ws)).testsFor(source?.path ?? '')).toEqual([]);
    // 2. harness-owned file
    expect(writePolicy(task, pkg?.path ?? '').allowed).toBe(false);
    // 3. path escape
    expect(toApiRel(ws, outside?.path ?? '').ok).toBe(false);
    // 4. unsafe test code
    expect(test?.content).toContain('as any');
    expect(findUnsafeCode(test?.path ?? 'x.ts', test?.content ?? '').map((v) => v.kind)).toContain('any');
  });
});
