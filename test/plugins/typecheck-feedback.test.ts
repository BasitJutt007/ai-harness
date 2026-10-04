/**
 * typecheck-feedback: the post-tool hook. After a write it type-checks just the written file(s)
 * in-process and RECORDS the errors on the tool result (at most 3 lines); it never blocks and never
 * writes a file. A check over its time budget is cancelled and skipped.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import typecheckFeedback, { BUDGET_MS, checkFiles, formatNote, MAX_OVERRUNS } from '../../plugins/hooks/typecheck-feedback.ts';
import writeFile from '../../plugins/tools/write_file.ts';
import type { HookVerdict, RunContext, ToolResult } from '../../src/core/plugin-api.ts';
import { callInfo, callTool, HARNESS_ROOT, makeHarness, removeTmp, sha } from './helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

/** The express-zod template as an API (its tsconfig and imports), so the check runs on a realistic program. */
function templateFiles(): Record<string, string> {
  const base = path.join(HARNESS_ROOT, 'templates', 'express-zod');
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[path.relative(base, abs).split(path.sep).join('/')] = readFileSync(abs, 'utf8');
    }
  };
  walk(base);
  return out;
}

async function harness() {
  const h = await makeHarness({ label: 'tsfeedback', files: templateFiles() });
  dirs.push(h.dir);
  return h;
}

/** Write through the real tool, then run the post hook on that call and its result (as the loop does). */
async function writeThenCheck(ctx: RunContext, p: string, content: string): Promise<{ verdict: HookVerdict; result: ToolResult }> {
  const result = await callTool(writeFile, { path: p, content }, ctx);
  const verdict = await typecheckFeedback.run({ event: 'post_tool', call: callInfo(writeFile, { path: p, content }), result }, ctx);
  return { verdict, result };
}

describe('typecheck-feedback (post_tool)', () => {
  it('reads only inside the API tree: a file outside it, imported by absolute path, never reaches the note', async () => {
    const h = await harness();
    const outsideDir = await makeHarness({ label: 'tsfeedback-outside', files: { 'secret.ts': "export interface Leaked { CANARY_TYPECHECK_FEEDBACK_9f2c: number }\n" } });
    dirs.push(outsideDir.dir);
    const outsideFile = path.join(outsideDir.ctx.workspace.root, 'secret.ts');
    // If the file were read, TS2741 would name the missing property: "Property 'CANARY…' is missing in type '{}'".
    const content = `import type { Leaked } from '${outsideFile}';\nexport const n: Leaked = {};\n`;
    const { verdict } = await writeThenCheck(h.ctx, 'test/probe.test.ts', content);
    const note = verdict.decision === 'record' ? verdict.note : '';
    expect(note).not.toContain('CANARY_TYPECHECK_FEEDBACK_9f2c');
  });

  it('records type and syntax errors of the written file with file:line, and passes a clean file', async () => {
    const h = await harness();
    const good = "import { z } from 'zod';\nexport const Name = z.string().min(1);\nexport function greet(n: string): string { return `hi ${n}`; }\n";
    // Cold start (lib and @types files) with a generous budget, so a loaded machine cannot flake the assertions below.
    await callTool(writeFile, { path: 'src/greet.ts', content: good }, h.ctx);
    const started = performance.now();
    expect(checkFiles(h.ctx.workspace.root, [path.join(h.ctx.workspace.root, 'src', 'greet.ts')], 60_000)).toEqual([]);
    const firstMs = performance.now() - started;
    expect((await writeThenCheck(h.ctx, 'src/greet.ts', good)).verdict).toEqual({ decision: 'pass' });

    const bad = "export function total(xs: number[]): number {\n  const first = xs[0];\n  return first + 1;\n}\nexport const n: number = 'one';\n";
    const t1 = performance.now();
    const { verdict } = await writeThenCheck(h.ctx, 'src/total.ts', bad);
    const warmMs = performance.now() - t1;
    expect(verdict.decision).toBe('record');
    const note = verdict.decision === 'record' ? verdict.note : '';
    expect(note).toMatch(/^tsc: 2 error\(s\): src\/total\.ts:3:10 TS18048 /); // noUncheckedIndexedAccess is forced
    expect(note).toContain("src/total.ts:5:14 TS2322 Type 'string' is not assignable to type 'number'.");
    expect(note.split('\n').length).toBeLessThanOrEqual(3);

    const broken = await writeThenCheck(h.ctx, 'src/total.ts', 'export const x = (;\n');
    expect(broken.verdict.decision === 'record' ? broken.verdict.note : '').toContain('src/total.ts:1:19 TS1109');
    // Informational only; a check over budget would have been cancelled (see below).
    console.info(`typecheck-feedback: first check ${Math.round(firstMs)} ms, warm check ${Math.round(warmMs)} ms (budget ${BUDGET_MS} ms)`);
  });

  it('never blocks and never writes: the file on disk is exactly what the tool wrote', async () => {
    const h = await harness();
    const bad = "export const n: number = 'one';\n";
    const { verdict, result } = await writeThenCheck(h.ctx, 'src/bad.ts', bad);
    expect(result.ok).toBe(true);
    expect(verdict.decision).not.toBe('block');
    expect(sha((await h.ctx.workspace.read('src/bad.ts')) ?? '')).toBe(sha(bad));
    // A failed write and non-TypeScript files are not checked.
    const failed = await typecheckFeedback.run({ event: 'post_tool', call: callInfo(writeFile, { path: 'src/bad.ts', content: bad }), result: { ok: false, summary: 'x' } }, h.ctx);
    expect(failed).toEqual({ decision: 'pass' });
    expect((await writeThenCheck(h.ctx, 'docs/notes.md', 'const x: number = "s"\n')).verdict).toEqual({ decision: 'pass' });
  });

  it('at most 3 lines, with the count of the rest', () => {
    expect(formatNote([])).toBeNull();
    const note = formatNote(['a:1 TS1 x', 'a:2 TS2 y', 'a:3 TS3 z', 'a:4 TS4 w', 'a:5 TS5 v']) ?? '';
    expect(note.split('\n')).toEqual(['tsc: 5 error(s): a:1 TS1 x', '  a:2 TS2 y', '  a:3 TS3 z (+2 more)']);
  });

  it('a check over budget is cancelled and skipped; repeated overruns switch the hook off for the API root', async () => {
    const h = await harness();
    await callTool(writeFile, { path: 'src/slow.ts', content: "export const n: number = 'one';\n" }, h.ctx);
    const abs = path.join(h.ctx.workspace.root, 'src', 'slow.ts');
    for (let i = 1; i < MAX_OVERRUNS; i += 1) expect(checkFiles(h.ctx.workspace.root, [abs], 0)).toBeNull();
    expect(checkFiles(h.ctx.workspace.root, [abs], 0)).toBeNull();
    // Off for this root: the next write is not checked (noted once when it switched off, then silent).
    const { verdict } = await writeThenCheck(h.ctx, 'src/slow.ts', "export const n: number = 'two';\n");
    expect(verdict).toEqual({ decision: 'pass' });
  });
});
