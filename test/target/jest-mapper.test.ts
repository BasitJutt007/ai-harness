/**
 * jest with tsconfig baseUrl/paths: imports like 'src/modules/x' (baseUrl ".") or '@app/x' (paths) resolve
 * under tsc but not under jest unless jest's moduleNameMapper maps them. When the repository's jest config
 * maps none of them, the harness passes an equivalent --moduleNameMapper on its own jest command line (the
 * config's entries kept verbatim); the repository's config is never edited, and a map it cannot read whole
 * is left alone. Each derivation is paired with the config that already covers it (no flag).
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { computeTargetProfile, jestPathMapper, type JestFacts } from '../../src/core/target.ts';
import { runTargetTests } from '../../src/core/testing.ts';
import type { Exec, LogStore } from '../../src/core/types.ts';
import { scratch, writeTree } from './_variants.ts';

const tmp = scratch('jest-mapper');
afterAll(() => tmp.cleanup());
const logs: LogStore = { write: async (name) => join(tmp.dir, `${name}.log`) };

const ABSENT: JestFacts = { rootDir: '.', mapper: { state: 'absent' }, resolvesBare: false };
const NO_BASE = { paths: [], baseUrl: null };

describe('jestPathMapper', () => {
  it('tsconfig paths become anchored regex keys against jest <rootDir>; an exact path maps exactly', () => {
    const r = jestPathMapper(tmp.dir, { paths: [{ pattern: '@app/*', targets: ['src/app/*'] }, { pattern: '@config', targets: ['src/config/index.ts'] }], baseUrl: null }, ABSENT);
    expect(r).toEqual({
      mapper: { '^@app/(.*)$': '<rootDir>/src/app/$1', '^@config$': '<rootDir>/src/config/index.ts' },
      added: ['^@app/(.*)$', '^@config$'],
    });
  });

  it("baseUrl \".\" maps each top-level directory (never node_modules, a dot-dir or an installed package's name), relative to jest's rootDir", () => {
    const root = join(tmp.dir, 'base');
    writeTree(root, { 'src/modules/x.ts': '', 'test/a.ts': '', '.github/x.yml': '', 'lodash/x.ts': '', 'node_modules/lodash/package.json': '{}' });
    const r = jestPathMapper(root, { paths: [], baseUrl: '.' }, { ...ABSENT, rootDir: 'src' });
    expect(r).toEqual({ mapper: { '^src/(.*)$': '<rootDir>/$1', '^test/(.*)$': '<rootDir>/../test/$1' }, added: ['^src/(.*)$', '^test/(.*)$'] });
  });

  it("keeps the config's own entries verbatim (the flag replaces its map) and adds only what it does not cover", () => {
    const facts: JestFacts = { ...ABSENT, mapper: { state: 'static', entries: { '\\.(css|less)$': 'identity-obj-proxy', '^@app/(.*)$': '<rootDir>/src/app/$1' } } };
    const r = jestPathMapper(tmp.dir, { paths: [{ pattern: '@app/*', targets: ['src/app/*'] }, { pattern: '@lib/*', targets: ['src/lib/*'] }], baseUrl: null }, facts);
    expect(r).toEqual({ mapper: { '\\.(css|less)$': 'identity-obj-proxy', '^@app/(.*)$': '<rootDir>/src/app/$1', '^@lib/(.*)$': '<rootDir>/src/lib/$1' }, added: ['^@lib/(.*)$'] });
  });

  it('the twin: a config that already maps every path gets no flag', () => {
    const facts: JestFacts = { ...ABSENT, mapper: { state: 'static', entries: { '^@app/(.*)$': '<rootDir>/src/app/$1' } } };
    expect(jestPathMapper(tmp.dir, { paths: [{ pattern: '@app/*', targets: ['src/app/*'] }], baseUrl: null }, facts)).toBeNull();
    expect(jestPathMapper(tmp.dir, NO_BASE, ABSENT)).toBeNull();
  });

  it('a map the harness cannot read whole is left alone (a note); modulePaths/moduleDirectories leave baseUrl to jest', () => {
    expect(jestPathMapper(tmp.dir, { paths: [{ pattern: '@app/*', targets: ['src/app/*'] }], baseUrl: null }, { ...ABSENT, mapper: { state: 'unknown' } }))
      .toEqual({ note: expect.stringMatching(/moduleNameMapper \(or rootDir\) is not static/) });
    const root = join(tmp.dir, 'base2');
    writeTree(root, { 'src/x.ts': '' });
    expect(jestPathMapper(root, { paths: [], baseUrl: '.' }, { ...ABSENT, resolvesBare: true })).toBeNull();
  });
});

/** A fake jest 29 install (package.json with a bin): enough for the profile to call jest supported. */
const FAKE_JEST = {
  'node_modules/jest/package.json': JSON.stringify({ name: 'jest', version: '29.7.0', bin: { jest: 'bin/jest.js' } }),
  'node_modules/jest/bin/jest.js': '',
};

describe('the profile and the jest command line', () => {
  it("a NestJS-style config (rootDir src, no mapper) with baseUrl \".\": the harness's jest call carries the derived --moduleNameMapper", async () => {
    const root = join(tmp.dir, 'nest');
    writeTree(root, {
      ...FAKE_JEST,
      'package.json': JSON.stringify({ name: 'api', scripts: { test: 'jest' }, devDependencies: { jest: '29.7.0' }, jest: { rootDir: 'src', testRegex: '.*\\.spec\\.ts$', moduleFileExtensions: ['js', 'json', 'ts'] } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: './', module: 'commonjs' } }),
      'src/modules/users.ts': 'export const users = [];\n',
      'src/modules/users.spec.ts': "import { users } from 'src/modules/users';\ndescribe('u', () => { it('x', () => { expect(users).toEqual([]); }); });\n",
    });
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    expect(p.runner).toMatchObject({ kind: 'jest', supported: true, moduleNameMapper: { '^src/(.*)$': '<rootDir>/$1' } });
    expect(p.notes.join('\n')).toMatch(/passed as --moduleNameMapper \(\^src\/\(\.\*\)\$\); the repository's config is not edited/);
    const calls: string[][] = [];
    const fake: Exec = async (_cmd, args) => {
      calls.push(args);
      return { code: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    };
    await runTargetTests({ root, exec: fake, harnessRoot: HARNESS_ROOT, logs, turn: 1, runner: p.runner, layout: p });
    expect(calls[0]).toContain('--moduleNameMapper={"^src/(.*)$":"<rootDir>/$1"}');
  });

  it('the twin: a jest.config.js computing its map (ts-jest pathsToModuleNameMapper) gets no flag, and the profile says why', async () => {
    const root = join(tmp.dir, 'computed');
    writeTree(root, {
      ...FAKE_JEST,
      'package.json': JSON.stringify({ name: 'api', scripts: { test: 'jest' }, devDependencies: { jest: '29.7.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }),
      'jest.config.js': "const { pathsToModuleNameMapper } = require('ts-jest');\nconst { compilerOptions } = require('./tsconfig.json');\nmodule.exports = { moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/' }) };\n",
      'src/app/x.ts': 'export {};\n',
    });
    const p = await computeTargetProfile({ apiRoot: root, repoRoot: root, harnessRoot: HARNESS_ROOT });
    expect(p.runner.kind).toBe('jest');
    expect(p.runner.moduleNameMapper).toBeUndefined();
    expect(p.notes.join('\n')).toMatch(/moduleNameMapper \(or rootDir\) is not static/);
  });
});
