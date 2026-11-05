/**
 * The scripted end-to-end demo (fixtures/scripted/session-demo.json) in a small web repository, with
 * the real registry: every real hook and every real gate, the real scripted driver, the real test
 * runner, a real Measure reading. The owner types (on the terminal channel): hello, the request, yes.
 *
 * Asserted: the reply streams with no tool, the contract is proposed and approved in chat, the red is
 * observed before the source edit, the suite goes green, and the verdict printed is the one the fresh
 * gates gave: "Work completed" appears if and only if run.json records DONE. Nothing is committed.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScriptedDriver } from '../../plugins/drivers/scripted.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { detectMechanism, isolationInfo } from '../../src/core/sandbox.ts';
import { ScriptedInput } from '../../src/session/input.ts';
import { runSession } from '../../src/session/session.ts';
import { WORK_COMPLETED } from '../../src/session/ui.ts';
import { git, realRegistry } from './helpers.ts';

const DEMO = join(HARNESS_ROOT, 'fixtures', 'scripted', 'session-demo');
// Under the harness's .harness/tmp; the repository's node_modules is a link to the harness's (an
// installed checkout), so its own tsc, Vite and vitest run as they would for the owner.
const dir = join(HARNESS_ROOT, '.harness', 'tmp', `session-demo-${process.pid}-${Date.now()}`);
const repo = join(dir, 'greeting-web');
const home = join(dir, 'home');

let out = '';
let runJson: Record<string, unknown> = {};
let code = -1;

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  cpSync(join(DEMO, 'repo'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'branch', 'development');
  git(repo, 'switch', '-q', '-c', 'fix/greeting-trim');
  symlinkSync(join(HARNESS_ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
  const driver = createScriptedDriver({ options: { script: join(HARNESS_ROOT, 'fixtures', 'scripted', 'session-demo.json') }, env: {}, harnessRoot: HARNESS_ROOT });
  const input = new ScriptedInput(['hello', 'names with spaces around them get extra spaces in the greeting, fix it', 'yes', '/diff', '/status'], 'tty');
  const r = await runSession({
    cwd: repo,
    input,
    output: { write: (t) => void (out += t), isTTY: false },
    env: { ...process.env, SF_HARNESS_HOME: home, NO_COLOR: '1' },
    exec,
    registry: await realRegistry(),
    driver,
  });
  code = r.code;
  runJson = JSON.parse(readFileSync(join(r.sessionDir ?? '', 'run.json'), 'utf8')) as Record<string, unknown>;
}, 600_000);

afterAll(() => {
  if (process.env['KEEP_DEMO'] === undefined) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(detectMechanism() === 'none' && isolationInfo().mode === 'auto')('session demo, end to end', () => {
  it('starts and ends cleanly', () => {
    expect(code).toBe(0);
    expect(runJson).toMatchObject({ kind: 'session', status: 'ended', branch: 'fix/greeting-trim', writable: true });
  });

  it('chats, reads, proposes, and takes the typed yes', () => {
    expect(out).toContain("Hi! I'm sf-harness, a governed coding agent.");
    expect(out).toMatch(/● search_code /);
    expect(out).toMatch(/● read_file src\/greeting\.ts/);
    expect(out).toMatch(/┌ PROPOSAL greeting-trim/);
    expect(out).toMatch(/│ before value: 1 \(read by the harness at development [0-9a-f]{12}\)/);
    expect(out).toMatch(/✔ approved: the owner at this terminal approved proposal seq 1 in a typed turn/);
  });

  it('red before the source edit, then green', () => {
    expect(out).toMatch(/✎ write_file wrote test\/greeting-trim\.test\.ts/);
    expect(out).toMatch(/● run_tests .*1 failed/);
    expect(out).toMatch(/✎ edit_file edited src\/greeting\.ts \(\+1 −1\)/);
    expect(out).toMatch(/● run_tests .*2 passed/);
    expect(out).toMatch(/◆ finish accepted by the gates/);
  });

  it('every required gate, run fresh by the harness, is green: "Work completed", recorded in run.json; nothing is committed', () => {
    // The printed verdict is the recorded one, whatever it is (the fail-closed property)...
    const kind = runJson['lastVerdict'];
    expect(out.includes(WORK_COMPLETED)).toBe(kind === 'DONE');
    // ...and on this repository, with its own tsc, Vite and vitest installed, it is DONE.
    expect(kind, out.slice(out.indexOf('gates  fresh run'))).toBe('DONE');
    expect(out).toMatch(/standards {2}pass 100% .*repo-typecheck pass, vite-build pass/);
    expect(git(repo, 'log', '--oneline').split('\n')).toHaveLength(1);
    expect(git(repo, 'status', '--porcelain').split('\n').map((l) => l.trim()).sort()).toEqual(['?? test/greeting-trim.test.ts', 'M src/greeting.ts']);
    expect(out).toContain('+  return `Hello, ${name.trim()}`;');
  });
});
