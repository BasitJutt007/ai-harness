/**
 * What a generic web repository can never prove reaches the owner before the first turn: the session banner
 * prints the profile's unsupported parts (never its notes), so "Work completed cannot be reached" (no type
 * check or lint configured) and "contract changes are not locked" (a server framework on stack web) are
 * unsupported parts, not notes. Real scripted sessions, no model call. Each with its twin that shows nothing.
 */
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { WEB_NO_STANDARDS_NOTE, webServerNote } from '../../src/core/target.ts';
import { runScripted, text, webRepo, type WebRepo } from './helpers.ts';

let r: WebRepo | null = null;
afterEach(() => {
  r?.cleanup();
  r = null;
});

const pkg = (deps: Record<string, string>): string => `${JSON.stringify({ name: 'tiny-web', private: true, type: 'module', scripts: { test: 'node --test' }, dependencies: deps })}\n`;

/** A JavaScript-only repository: the webRepo default's TypeScript files removed and committed, so the tree is clean. */
async function banner(extra: Record<string, string>): Promise<{ out: string; target: { stack?: string; unsupported?: string[] } }> {
  r = webRepo({ extra });
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: r?.repo, encoding: 'utf8' });
  git('rm', '-q', 'src/greeting.ts', 'test/greeting.test.ts');
  git('commit', '-q', '-m', 'javascript only');
  const ran = await runScripted(r, [text('Hello.')], ['hello']);
  expect(ran.out).toContain('Hello.');
  return { out: ran.out, target: ran.runJson['target'] as { stack?: string; unsupported?: string[] } };
}

describe('the session banner shows what a web repository can never prove', () => {
  it('no tsconfig and no ESLint: the banner says "Work completed" cannot be reached', async () => {
    const { out, target } = await banner({ 'package.json': pkg({ lit: '^3.0.0' }), 'src/main.js': 'export const x = 1;\n' });
    expect(target.stack).toBe('web');
    expect(target.unsupported).toEqual([WEB_NO_STANDARDS_NOTE]);
    expect(out).toContain(`UNPROVEN: ${WEB_NO_STANDARDS_NOTE}`);
  });

  it('the twin with an ESLint config shows no such line', async () => {
    const { out, target } = await banner({ 'package.json': pkg({ lit: '^3.0.0' }), 'src/main.js': 'export const x = 1;\n', 'eslint.config.js': 'export default [];\n' });
    expect(target.stack).toBe('web');
    expect(target.unsupported).toEqual([]);
    expect(out).not.toContain('cannot be reached');
  });

  it('a JavaScript Express repository: the banner says its routes are not locked', async () => {
    const { out, target } = await banner({
      'package.json': pkg({ express: '5.2.1' }),
      'src/app.js': "import express from 'express';\nexport const app = express();\n",
      'eslint.config.js': 'export default [];\n',
    });
    expect(target.stack).toBe('web');
    expect(target.unsupported).toEqual([webServerNote('express')]);
    expect(out).toContain(`UNPROVEN: ${webServerNote('express')}`);
  });
});
