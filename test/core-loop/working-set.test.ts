/**
 * Working set (real-model finding F1: models re-read the same files in a loop once compaction
 * folded the read turn into the digest): after the digest, a skeleton of each file read in a
 * folded turn and not written since, most recent first, within WORKING_SET_CHARS.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import readFileTool from '../../plugins/tools/read_file.ts';
import writeFileTool from '../../plugins/tools/write_file.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { runAgent } from '../../src/core/loop.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import { CONFIG, call, fakeCtx, FakeDriver, fakeStore, firstMessage, reply, specs } from './fakes.ts';
import {
  DIGEST_HEADER,
  jitView,
  skeleton,
  SKELETON_LINES,
  WORKING_SET_CHARS,
  WORKING_SET_HEADER,
  workingSet,
  type TranscriptTurn,
} from '../../src/core/context.ts';
import type { Message, Part, ToolPlugin } from '../../src/core/types.ts';

const first: Message = { role: 'user', parts: [{ type: 'text', text: 'brief' }] };

/** A read_file result as the tool renders it: header, then `<n>| <code>` lines. */
function listing(path: string, code: string[]): string {
  const width = String(code.length).length;
  return [`${path} (lines 1-${code.length} of ${code.length})`, ...code.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`)].join('\n');
}

const APP = [
  "import express from 'express';",
  "import { registerRoutes } from './routes/index.ts';",
  '',
  'export function createApp(): express.Express {',
  '  const app = express();',
  '  registerRoutes(app);',
  '  return app;',
  '}',
];

interface Call {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

function turn(n: number, calls: Call[]): TranscriptTurn {
  const parts: Part[] = [{ type: 'text', text: `step ${n}` }];
  const results: Part[] = [];
  calls.forEach((c, i) => {
    const id = `c${n}_${i}`;
    parts.push({ type: 'tool_call', id, name: c.name, input: c.input });
    results.push({ type: 'tool_result', callId: id, content: c.result ?? 'ok', isError: c.isError ?? false });
  });
  return { turn: n, assistant: { role: 'assistant', parts }, results: { role: 'user', parts: results }, raw: {} };
}

const read = (path: string, code: string[]): Call => ({ name: 'read_file', input: { path }, result: listing(path, code) });
const noop = (n: number): TranscriptTurn => turn(n, [{ name: 'run_tests', input: {}, result: `tests: ${n} passed` }]);

function headTexts(view: Message[]): string[] {
  return (view[0]?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : []));
}

describe('skeleton', () => {
  it('keeps the header and top-level signature lines with their numbers, never bodies', () => {
    const s = skeleton(listing('src/app.ts', APP));
    expect(s.split('\n')).toEqual([
      'src/app.ts (lines 1-8 of 8)',
      "1| import express from 'express';",
      "2| import { registerRoutes } from './routes/index.ts';",
      '4| export function createApp(): express.Express {',
    ]);
  });

  it('keeps the signature lines of a CRLF file (each listed line ends in \\r), without the \\r', () => {
    const crlf = listing('src/crlf.ts', APP.map((l) => `${l}\r`));
    expect(skeleton(crlf).split('\n')).toEqual(skeleton(listing('src/crlf.ts', APP)).split('\n'));
    expect(skeleton(crlf)).toContain('4| export function createApp(): express.Express {');
    expect(skeleton(crlf)).not.toContain('\r');
  });

  it('copes with odd inputs: empty, header only, no numbered lines, CRLF-free garbage, very long lines', () => {
    expect(skeleton('')).toBe('');
    expect(skeleton('src/x.ts (empty file)')).toBe('src/x.ts (empty file)');
    expect(skeleton('not a listing\nat all\n|||')).toBe('not a listing');
    const long = `export const big = '${'x'.repeat(400)}';`;
    const s = skeleton(listing('src/big.ts', [long]));
    const line = s.split('\n')[1] ?? '';
    expect(line.length).toBe(161); // 160 chars + ellipsis
    expect(line.endsWith('…')).toBe(true);
  });

  it(`caps the signature lines at ${SKELETON_LINES} and says how many more there are`, () => {
    const code = Array.from({ length: SKELETON_LINES + 7 }, (_, i) => `export const v${i} = ${i};`);
    const lines = skeleton(listing('src/many.ts', code)).split('\n');
    expect(lines).toHaveLength(1 + SKELETON_LINES + 1);
    expect(lines[lines.length - 1]).toBe('… 7 more signature lines');
  });
});

describe('workingSet', () => {
  it('a file read at t2 and never written stays in full just after it folds, then as a skeleton', () => {
    // Real runs: a model editing three related files re-read them in a 3-turn cycle when only skeletons
    // survived; a folded read now stays in full for WORKING_SET_FULL_TURNS turns, then becomes a skeleton.
    const recent = [noop(1), turn(2, [read('src/app.ts', APP)]), noop(3), noop(4), noop(5), noop(6)];
    const texts = headTexts(jitView(first, recent, 2, true));
    expect(texts[0]).toBe('brief');
    expect(texts[1]?.startsWith(DIGEST_HEADER)).toBe(true); // digest first (append-only prefix)
    expect(texts[2]?.startsWith(WORKING_SET_HEADER)).toBe(true); // working set after it
    expect(texts[2]).toContain('src/app.ts (lines 1-8 of 8)');
    expect(texts[2]).toContain('const app = express()'); // full body while recently folded

    const later = [noop(1), turn(2, [read('src/app.ts', APP)]), noop(3), noop(4), noop(5), noop(6), noop(7), noop(8), noop(9)];
    const old = headTexts(jitView(first, later, 2, true))[2];
    expect(old).toContain('4| export function createApp(): express.Express {'); // signature kept
    expect(old).not.toContain('const app = express()'); // body stays out once old
  });

  it('a later write of the file drops it (stale), in a later turn or later in the same turn', () => {
    const later = [turn(1, [read('src/app.ts', APP)]), turn(2, [{ name: 'edit_file', input: { path: 'src/app.ts', find: 'a', replace: 'b' } }]), noop(3), noop(4)];
    expect(workingSet(later, 2)).toBeNull();
    const sameTurn = [turn(1, [read('src/app.ts', APP), { name: 'write_file', input: { path: './src/app.ts', content: 'x' } }]), noop(2), noop(3)];
    expect(workingSet(sameTurn, 1)).toBeNull();
    // a write BEFORE the read in the same turn does not make that read stale
    const writeThenRead = [turn(1, [{ name: 'write_file', input: { path: 'src/app.ts', content: 'x' } }, read('src/app.ts', APP)]), noop(2), noop(3)];
    expect(workingSet(writeThenRead, 1)).toContain('src/app.ts (lines 1-8 of 8)');
  });

  it('a write is matched by its canonical path (recorded by the loop), whatever the raw input path was', () => {
    for (const raw of ['SRC/app.ts', '/abs/repo/api/src/app.ts', 'src//app.ts']) {
      const t2 = turn(2, [{ name: 'write_file', input: { path: raw, content: 'x' } }]);
      t2.written = { c2_0: ['src/app.ts'] };
      expect(workingSet([turn(1, [read('src/app.ts', APP)]), t2, noop(3), noop(4)], 2), raw).toBeNull();
    }
  });

  it('without a recorded path, the input path is normalised like the path policy does (//, ./, a/../, backslashes)', () => {
    for (const raw of ['src//app.ts', 'src/./app.ts', './src/lib/../app.ts', 'src\\app.ts', '/src/app.ts']) {
      const turns = [turn(1, [read('src/app.ts', APP)]), turn(2, [{ name: 'write_file', input: { path: raw, content: 'x' } }]), noop(3), noop(4)];
      expect(workingSet(turns, 2), raw).toBeNull();
    }
  });

  it('a FAILED recent re-read of a file does not hide its skeleton (only a visible read does)', () => {
    const failed = { name: 'read_file', input: { path: 'src/app.ts', startLine: 50 }, result: 'read_file: src/app.ts has only 8 lines (startLine 50)', isError: true };
    const turns = [turn(1, [read('src/app.ts', APP)]), noop(2), turn(3, [failed])];
    expect(workingSet(turns, 1)).toContain('4| export function createApp(): express.Express {');
    const ok = [turn(1, [read('src/app.ts', APP)]), noop(2), turn(3, [read('src/app.ts', APP)])];
    expect(workingSet(ok, 1)).toBeNull();
  });

  it('only offered write tools count: a custom write tool passed by the loop makes reads stale', () => {
    const turns = [turn(1, [read('src/app.ts', APP)]), turn(2, [{ name: 'patch_file', input: { path: 'src/app.ts' } }]), noop(3), noop(4)];
    expect(workingSet(turns, 2)).toContain('src/app.ts');
    expect(workingSet(turns, 2, ['write_file', 'patch_file'])).toBeNull();
  });

  it('leaves out files read again in the kept recent turns, failed reads and non-read tools', () => {
    const turns = [
      turn(1, [read('src/app.ts', APP), { name: 'read_file', input: { path: 'src/missing.ts' }, result: 'read_file: src/missing.ts does not exist', isError: true }]),
      turn(2, [{ name: 'search_code', input: { path: 'src', pattern: 'x' }, result: 'src/a.ts:1 x' }]),
      turn(3, [read('src/app.ts', APP)]),
    ];
    expect(workingSet(turns, 2)).toBeNull();
  });

  it('newest read first; the budget skips what does not fit and keeps going', () => {
    const big = Array.from({ length: SKELETON_LINES }, (_, i) => `export const v${i} = '${'y'.repeat(150)}';`);
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
    const turns = [...files.map((f, i) => turn(i + 1, [read(f, big)])), turn(6, [read('src/small.ts', ['export const s = 1;'])]), noop(7), noop(8)];
    const ws = workingSet(turns, 6) ?? '';
    const order = ['src/small.ts', ...[...files].reverse()].filter((f) => ws.includes(`${f} (lines`));
    expect(ws.indexOf('src/small.ts')).toBeLessThan(ws.indexOf('src/e.ts'));
    expect(order[0]).toBe('src/small.ts');
    expect(ws.length).toBeLessThanOrEqual(WORKING_SET_CHARS + WORKING_SET_HEADER.length + 16);
    // each big skeleton is ~6.6K chars: only one of them fits next to small.ts, and it is the newest (e)
    expect(order).toEqual(['src/small.ts', 'src/e.ts']);
  });

  it('is a pure function of the transcript (same input, same output; no mutation)', () => {
    const turns = [turn(1, [read('src/app.ts', APP)]), noop(2), noop(3)];
    const before = JSON.stringify(turns);
    expect(workingSet(turns, 1)).toBe(workingSet(turns, 1));
    expect(JSON.stringify(turns)).toBe(before);
  });

  it('keeps the digest append-only: the working set only ever follows it', () => {
    const turns = [turn(1, [read('src/app.ts', APP)]), noop(2), noop(3), noop(4), noop(5)];
    let previousDigest = '';
    for (let n = 3; n <= turns.length; n += 1) {
      const texts = headTexts(jitView(first, turns.slice(0, n), 2, true));
      const digest = texts[1] ?? '';
      expect(digest.startsWith(previousDigest)).toBe(true);
      previousDigest = digest;
      expect(texts[2]?.startsWith(WORKING_SET_HEADER)).toBe(true);
    }
  });
});

describe('working set through the loop with the real read_file / write_file tools', () => {
  const base = join(HARNESS_ROOT, '.harness', 'tmp', `working-set-${randomBytes(4).toString('hex')}`);
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** t1 read src/a.ts, t2 write it through `writePath`, t3/t4 read src/b.ts: what the t5 request says about src/a.ts. */
  async function afterWrite(label: string, writePath: (apiRoot: string) => string): Promise<{ head: string; disk: string }> {
    const repo = join(base, label);
    const api = join(repo, 'api');
    mkdirSync(join(api, 'src'), { recursive: true });
    writeFileSync(join(api, 'src', 'a.ts'), 'export function oldName(): number {\n  return 1;\n}\n');
    writeFileSync(join(api, 'src', 'b.ts'), 'export const b = 2;\n');
    const tools = [readFileTool, writeFileTool].map((t) => t as ToolPlugin<unknown>);
    const { ctx: base0, logs } = fakeCtx({ tools });
    const ctx = { ...base0, workspace: createWorkspace(repo, 'api'), config: { ...CONFIG, history: { ...CONFIG.history, keepRecentTurns: 2 } } };
    const driver = new FakeDriver([
      reply([call('r1', 'read_file', { path: 'src/a.ts' })]),
      reply([call('w1', 'write_file', { path: writePath(api), content: 'export function newName(x: string): string {\n  return x;\n}\n' })]),
      reply([call('r2', 'read_file', { path: 'src/b.ts' })]),
      reply([call('r3', 'read_file', { path: 'src/b.ts', startLine: 1 })]),
      reply([{ type: 'text', text: 'done' }], 'end_turn'),
    ]);
    await runAgent({
      driver,
      ctx,
      store: fakeStore(logs),
      ledger: new TokenLedger({ runId: 'r', task: 't', driver: 'fake', model: 'm', counter: 'chars/4', mode: 'jit' }),
      first: firstMessage(),
      system: 'S',
      baselineSystem: 'S+F',
      tools: specs(tools),
      maxTurns: 5,
      maxOutputTokens: 100,
      retryDelaysMs: [],
    });
    const req = driver.requests[4];
    const head = (req?.messages[0]?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
    return { head, disk: readFileSync(join(api, 'src', 'a.ts'), 'utf8') };
  }

  const variants: Array<[string, (api: string) => string]> = [
    ['canonical', () => 'src/a.ts'],
    ['double-slash', () => 'src//a.ts'],
    ['dot-segment', () => 'src/./a.ts'],
    ['absolute', (api) => join(api, 'src', 'a.ts')],
  ];
  for (const [label, writePath] of variants) {
    it(`a write through a path in ${label} form makes the earlier read of src/a.ts stale`, async () => {
      const r = await afterWrite(label, writePath);
      expect(r.disk).toContain('newName');
      expect(r.head).not.toContain('oldName'); // never the rewritten file's old shape
    });
  }

  it('control: a write of another file leaves the src/a.ts skeleton in the working set', async () => {
    const r = await afterWrite('other-file', () => 'src/c.ts');
    expect(r.head).toContain(WORKING_SET_HEADER);
    expect(r.head).toContain('1| export function oldName(): number {');
  });

  it('a write through another letter case (on a case-insensitive filesystem) makes it stale too', async () => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'probe.txt'), 'x');
    const caseInsensitive = existsSync(join(base, 'PROBE.TXT'));
    const r = await afterWrite('upper-case', () => 'SRC/a.ts');
    // On a case-sensitive filesystem SRC/a.ts is another file and src/a.ts really is unchanged.
    expect(r.head.includes('oldName')).toBe(!caseInsensitive);
    expect(r.disk.includes('newName')).toBe(caseInsensitive);
  });
});
