/**
 * Load-error location (real-model finding F4): a suite that fails to load reported only
 * "app.use() requires a middleware function", and the model re-read files for 20 turns looking
 * for it. The runner's console names the place ("❯ registerRoutes src/routes/index.ts:10:7" and
 * the code frame); the summary now carries it.
 *
 * Fixture: test/fixtures/vitest/load-error-console.txt is the console (stdout + stderr) of a real
 * run, with only the absolute paths shortened.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { capBytes, errorLocation, MAX_CONSOLE_BYTES, runVitest } from '../../src/core/testing.ts';
import type { Exec, LogStore } from '../../src/core/types.ts';

const CONSOLE = readFileSync(join(HARNESS_ROOT, 'test', 'fixtures', 'vitest', 'load-error-console.txt'), 'utf8');
const MESSAGE = 'app.use() requires a middleware function';

describe('errorLocation on a real runner console', () => {
  it('names the first in-project frame of the file\'s own block and the line of code', () => {
    expect(errorLocation(CONSOLE, 'test/users.test.ts', MESSAGE)).toBe('at src/routes/index.ts:10:7  app.use(usersRouter);');
  });

  it('skips frames outside the project (node_modules, ../)', () => {
    const loc = errorLocation(CONSOLE, 'test/users.test.ts', `TypeError: ${MESSAGE}`) ?? '';
    expect(loc).not.toMatch(/node_modules|application\.js/);
  });

  it('reads the block of the file asked about, not an earlier block with the same message', () => {
    const other = [
      ' FAIL  test/other.test.ts [ test/other.test.ts ]',
      `TypeError: ${MESSAGE}`,
      ' ❯ app.use ../../node_modules/express/lib/application.js:213:11',
      ' ❯ mountOther src/other.ts:3:5',
      '      2|',
      '      3|   app.use(otherRouter);',
      '       |     ^',
      '',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯',
      '',
    ].join('\n');
    const text = CONSOLE.replace(' FAIL  test/users.test.ts', `${other}\n FAIL  test/users.test.ts`);
    expect(errorLocation(text, 'test/other.test.ts', MESSAGE)).toBe('at src/other.ts:3:5  app.use(otherRouter);');
    expect(errorLocation(text, 'test/users.test.ts', MESSAGE)).toBe('at src/routes/index.ts:10:7  app.use(usersRouter);');
  });

  it('never borrows a frame from the next block', () => {
    const text = [
      ' FAIL  test/a.test.ts [ test/a.test.ts ]',
      'Error: boom',
      ' ❯ ../../node_modules/x/index.js:1:1',
      '',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯',
      '',
      ' FAIL  test/b.test.ts [ test/b.test.ts ]',
      'Error: boom',
      ' ❯ src/b.ts:2:2',
    ].join('\n');
    expect(errorLocation(text, 'test/a.test.ts', 'boom')).toBeNull();
    expect(errorLocation(text, 'test/b.test.ts', 'boom')).toBe('at src/b.ts:2:2');
  });

  it('is null when the console has no failure header for the file (the 64 KB cap dropped it), never another file\'s frame', () => {
    const msg = "TypeError: Cannot read properties of undefined (reading 'id')";
    const block = (file: string, frame: string, code: string, n: number): string =>
      [` FAIL  ${file} [ ${file} ]`, msg, ` ❯ ${frame}`, `      ${n}| ${code}`, '       |     ^', '', '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯', ''].join('\n');
    const logs = Array.from({ length: 600 }, (_, i) => `stdout | test/log.test.ts > logs\nlog line ${i} ${'x'.repeat(20)}`).join('\n');
    const diffs = Array.from({ length: 40 }, (_, i) => ` FAIL  test/z.test.ts > big ${i}\nAssertionError: expected deep equality\n${'- a\n+ b\n'.repeat(250)}⎯⎯⎯[${i}]⎯\n`).join('\n');
    const text = [logs, block('test/c.test.ts', 'src/x.ts:2:23', 'export const id = cfg.id;', 2), diffs, block('test/z.test.ts', 'readId src/y.ts:3:12', 'return v.id;', 3)].join('\n');
    expect(errorLocation(text, 'test/c.test.ts', msg)).toBe('at src/x.ts:2:23  export const id = cfg.id;');
    const capped = capBytes(text, MAX_CONSOLE_BYTES);
    expect(capped).not.toContain('FAIL  test/c.test.ts');
    expect(capped).toContain('src/y.ts:3:12');
    expect(errorLocation(capped, 'test/c.test.ts', msg)).toBeNull();
  });

  it('is null when the message is not inside the file\'s own block (no spill into the next one)', () => {
    const text = [
      ' FAIL  test/a.test.ts [ test/a.test.ts ]',
      'Error: first',
      ' ❯ src/a.ts:1:1',
      '',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯',
      '',
      ' FAIL  test/b.test.ts [ test/b.test.ts ]',
      'Error: second',
      ' ❯ src/b.ts:2:2',
    ].join('\n');
    expect(errorLocation(text, 'test/a.test.ts', 'Error: second')).toBeNull();
    expect(errorLocation(text, 'test/b.test.ts', 'Error: second')).toBe('at src/b.ts:2:2');
  });

  it('names the throw site of a constructor frame (`❯ new X src/…`), with its code line', () => {
    // Real vitest 5.0.3 console: a class whose constructor throws, instantiated at module load.
    const ctor = readFileSync(join(HARNESS_ROOT, 'test', 'fixtures', 'vitest', 'constructor-frame-console.txt'), 'utf8');
    expect(ctor).toContain(' ❯ new UsersService src/svc.ts:3:29');
    expect(errorLocation(ctor, 'test/a.test.ts', 'Error: UsersService needs a table name')).toBe(
      "at src/svc.ts:3:29  if (table === '') throw new Error('UsersService needs a table name…",
    );
  });

  it('is null without a message, or when the console does not contain it', () => {
    expect(errorLocation(CONSOLE, 'test/users.test.ts', '')).toBeNull();
    expect(errorLocation(CONSOLE, 'test/users.test.ts', 'some other failure')).toBeNull();
    expect(errorLocation('', 'test/users.test.ts', MESSAGE)).toBeNull();
  });
});

describe('the run_tests summary carries the location', () => {
  const base = join(HARNESS_ROOT, '.harness', 'tmp', `error-location-${randomBytes(4).toString('hex')}`);
  const root = join(base, 'api');
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('ERROR line of the suite that failed to load names src/routes/index.ts:10:7', async () => {
    const files: Record<string, string> = {
      'src/routes/index.ts': "import type { Router } from 'express';\nimport usersRouter from './users.ts';\n\n\n\n\n\n\nexport function registerRoutes(app: Router): void {\n  app.use(usersRouter);\n}\n",
      'test/users.test.ts': "import { it, expect } from 'vitest';\nimport { createApp } from '../src/app.ts';\nit('creates', () => { expect(createApp()).toBeDefined(); });\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    const report = JSON.stringify({
      testResults: [{ name: join(root, 'test/users.test.ts'), status: 'failed', message: MESSAGE, assertionResults: [] }],
    });
    // The runner itself is faked: its console is the real one from the fixture.
    const fake: Exec = async () => ({ code: 1, stdout: CONSOLE, stderr: '', channel: report, durationMs: 1, timedOut: false });
    const logs: LogStore = { write: async (name) => `runs/x/logs/${name}.txt` };
    const r = await runVitest({ root, files: ['test/users.test.ts'], exec: fake, harnessRoot: HARNESS_ROOT, logs, turn: 1 });
    expect(r.summary).toContain(`ERROR test/users.test.ts: suite error: ${MESSAGE} (at src/routes/index.ts:10:7  app.use(usersRouter);)`);
  });
});
