/**
 * typecheck-feedback as a session really runs it (the real registry's hooks on the loop's hook bus, a
 * scripted driver, a throwaway web repository in the OS temp dir): the note the model sees after a write
 * says what the repository's own type check would say. A node:test file under test/, which no tsconfig
 * project includes, gets no type feedback at all (the live session chased "Cannot find name 'node:test'"
 * there for ~20 turns); the same import in a test file the app project includes (src/) is recorded, as the
 * repository's type check would report it.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkInPlace } from '../../plugins/hooks/typecheck-feedback.ts';
import { calls, proposal, runScripted, TEST_BODY, text, webRepo, type WebRepo } from './helpers.ts';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', allowImportingTsExtensions: true, lib: ['ES2022', 'DOM'], strict: true, noEmit: true, types: [] };

let r: WebRepo;
beforeEach(() => {
  r = webRepo({
    extra: {
      // Solution-style, as a bundler app template ships it: the app project covers src/ only.
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': JSON.stringify({ compilerOptions: OPTIONS, include: ['src'] }),
      '.gitignore': 'node_modules/\n',
      // The repository's own TypeScript (the gate runs it); not committed.
      'node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version: '5.9.3' }),
    },
  });
});
afterEach(() => r.cleanup());

const OUTSIDE = 'test/greeting-name.test.ts';
const INSIDE = 'src/greeting-name.test.ts';

describe('typecheck-feedback in a session', () => {
  it('a node:test file in no tsconfig project gets no type note; the same import in src/ (the app project) is recorded', async () => {
    // Warm the app project's language service with a cold budget (the registry loads this same module), so
    // the session's own checks, under BUDGET_MS, are warm ones a loaded machine cannot cancel.
    expect(checkInPlace(r.repo, [join(r.repo, 'src', 'greeting.ts')], 60_000)).toEqual({ errors: [], project: [], uncovered: [], skipped: null });
    const ran = await runScripted(
      r,
      [
        calls(['propose_contract', proposal()]),
        calls(['write_file', { path: OUTSIDE, content: TEST_BODY }]),
        calls(['write_file', { path: INSIDE, content: TEST_BODY.replace('../src/greeting.ts', './greeting.ts') }]),
        text('Wrote both tests.'),
      ],
      ['fix the greeting', 'yes, go ahead'],
    );
    expect(ran.out).toMatch(/✎ write_file wrote test\/greeting-name\.test\.ts/);
    expect(ran.out).toMatch(/✎ write_file wrote src\/greeting-name\.test\.ts/);
    // What the model was sent after the first write: its tool result, with no type feedback.
    const afterOutside = JSON.stringify(ran.driver.requests[2]?.messages ?? []);
    expect(afterOutside).toContain('wrote test/greeting-name.test.ts');
    expect(afterOutside).not.toContain('[typecheck-feedback]');
    expect(afterOutside).not.toMatch(/TS25(80|91)/);
    // After the second: the import the app project's type check rejects, on the file it rejects it in.
    const afterInside = JSON.stringify(ran.driver.requests[3]?.messages ?? []);
    expect(afterInside).toMatch(/\[typecheck-feedback\] tsc: \d+ error\(s\): src\/greeting-name\.test\.ts:1:22 TS25(80|91) /);
    expect(afterInside).not.toMatch(/test\/greeting-name\.test\.ts:1:22/);
  });
});
