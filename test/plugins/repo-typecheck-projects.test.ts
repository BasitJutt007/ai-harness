/**
 * projectsOf, the project discovery of the repository's own type check (repo-typecheck, web-typecheck), read
 * through a config host: the gate leaves it out and reads with ts.sys, as before; an in-process caller over
 * agent-written code (typecheck-feedback in place) passes the read fence's host. Each project carries the
 * parse it was found with (its options and the files its include lists right now).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectsOf } from '../../plugins/checks/repo-typecheck.ts';
import { createTsFence } from '../../src/core/plugin-api.ts';

const bases: string[] = [];
afterEach(() => {
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

const APP = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: ['tiny-env/client'] }, include: ['src'] });

/** A checkout `<base>/repo` in the OS temp dir (outside the harness checkout), with `files`. */
function repo(files: Record<string, string>): { base: string; root: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'projects-of-'));
  bases.push(base);
  const root = path.join(base, 'repo');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return { base, root };
}

const fenced = (root: string) => ({ ...createTsFence(root).host, onUnRecoverableConfigFileDiagnostic: () => undefined });

describe('projectsOf through a config host (the gate keeps ts.sys)', () => {
  it('the fenced host finds the projects the gate finds, each with its parse (options and listed files)', () => {
    const { root } = repo({ 'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }), 'tsconfig.app.json': APP, 'src/a.ts': 'export const a = 1;\n' });
    const viaGate = projectsOf(root);
    const viaFence = projectsOf(root, fenced(root));
    expect(viaGate.problem).toBeUndefined();
    expect(viaFence.problem).toBeUndefined();
    expect(viaFence.projects.map((p) => path.basename(p.config))).toEqual(['tsconfig.app.json']);
    expect(viaFence.projects.map((p) => p.config)).toEqual(viaGate.projects.map((p) => p.config));
    expect(viaFence.projects.map((p) => p.parsed.fileNames.map((f) => path.basename(f)))).toEqual([['a.ts']]);
    expect(viaGate.projects.map((p) => p.parsed.fileNames)).toEqual(viaFence.projects.map((p) => p.parsed.fileNames));
    expect(viaFence.projects[0]?.parsed.options.types).toEqual(['tiny-env/client']);
  });

  it('a file added after one call is listed by the next (each call parses afresh)', () => {
    const { root } = repo({ 'tsconfig.json': APP, 'src/a.ts': 'export const a = 1;\n' });
    const host = fenced(root);
    expect(projectsOf(root, host).projects[0]?.parsed.fileNames.map((f) => path.basename(f))).toEqual(['a.ts']);
    writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
    expect(projectsOf(root, host).projects[0]?.parsed.fileNames.map((f) => path.basename(f)).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('a referenced project outside the checkout cannot be read through the fence; the gate (ts.sys) still reads it', () => {
    const { base, root } = repo({ 'tsconfig.json': JSON.stringify({ files: [], references: [{ path: '../elsewhere/tsconfig.app.json' }] }) });
    mkdirSync(path.join(base, 'elsewhere', 'src'), { recursive: true });
    writeFileSync(path.join(base, 'elsewhere', 'tsconfig.app.json'), APP);
    writeFileSync(path.join(base, 'elsewhere', 'src', 'x.ts'), 'export const x = 1;\n');
    expect(projectsOf(root).problem).toBeUndefined();
    expect(projectsOf(root, fenced(root)).problem).toMatch(/^referenced \.\.\/elsewhere\/tsconfig\.app\.json cannot be read$/);
  });

  it('a referenced DIRECTORY outside the checkout does not exist through the fence (never looked into); the gate looks for its tsconfig.json', () => {
    const { base, root } = repo({ 'tsconfig.json': JSON.stringify({ files: [], references: [{ path: '../elsewhere' }] }) });
    mkdirSync(path.join(base, 'elsewhere', 'src'), { recursive: true });
    writeFileSync(path.join(base, 'elsewhere', 'tsconfig.json'), APP);
    writeFileSync(path.join(base, 'elsewhere', 'src', 'x.ts'), 'export const x = 1;\n');
    expect(projectsOf(root).projects.map((p) => path.relative(base, p.config))).toEqual([path.join('elsewhere', 'tsconfig.json')]);
    // Existence goes through the host too: the fenced host reports the directory absent, so its tsconfig.json is never probed.
    expect(projectsOf(root, fenced(root)).problem).toBe('referenced ../elsewhere cannot be read');
  });

  it('no tsconfig.json is the same problem through either host', () => {
    const { root } = repo({ 'src/a.ts': 'export const a = 1;\n' });
    expect(projectsOf(root).problem).toBe('no tsconfig.json at the repository root');
    expect(projectsOf(root, fenced(root)).problem).toBe('no tsconfig.json at the repository root');
  });
});
