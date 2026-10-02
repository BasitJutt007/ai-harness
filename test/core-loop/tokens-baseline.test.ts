/**
 * Shadow-baseline front-load honesty: files + standards docs only. Tool schemas are already in
 * every request's tools array (counted once for both sides), so repeating them in the baseline
 * system prompt would inflate the baseline.
 */
import { describe, expect, it } from 'vitest';
import { countRequest } from '../../plugins/lib/tokenize.ts';
import { frontLoad, standardDoc, systemPrompt } from '../../src/core/prompt.ts';
import { BASELINE_DEFINITION } from '../../src/core/tokens.ts';
import type { CheckPlugin, ToolSpec, Workspace } from '../../src/core/types.ts';
import { GREENFIELD } from './fakes.ts';

const files: Record<string, string> = {
  'src/app.ts': 'export const app = 1;',
  'package.json': '{}',
  'node_modules/x/index.js': 'skip me',
  'img.png': 'PNG\u0000bin',
};
const ws: Workspace = {
  repoRoot: '/r', root: '/r', rootRel: '.',
  resolve: (p: string) => p, rel: (p: string) => p,
  read: async (p: string) => files[p] ?? null,
  write: async () => undefined, exists: async () => true,
  list: async () => Object.keys(files),
};

const full: CheckPlugin = { kind: 'check', id: 'zod-boundary', category: 'standards', description: 'one line', unit: 'handlers', doc: 'FULL DOC TEXT', run: async () => [] };
const described: CheckPlugin = { kind: 'check', id: 'orm-rule', category: 'orm', description: 'ORM ONE LINE', run: async () => [] };
const bare: CheckPlugin = { kind: 'check', id: 'lint-rule', category: 'lint', run: async () => [] };
const checks = [full, described, bare];
const tools: ToolSpec[] = [{ name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];

describe('frontLoad (shadow baseline system prompt)', () => {
  it('holds every text file under the API root and every standards doc, and no tool schema', async () => {
    const fl = await frontLoad({ ws, checks, tools });
    expect(fl).toContain('=== src/app.ts ===\nexport const app = 1;');
    expect(fl).toContain('=== package.json ===');
    expect(fl).not.toContain('node_modules');
    expect(fl).not.toContain('img.png');
    expect(fl).toContain('=== standard: zod-boundary ===\nFULL DOC TEXT');
    expect(fl).toContain('=== standard: orm-rule ===\nORM ONE LINE');
    expect(fl).toContain('=== standard: lint-rule ===\nlint-rule');
    expect(fl).not.toContain('=== tool:');
    expect(fl).not.toContain('"inputSchema"');
    expect(fl).not.toContain('"properties"');
    // tools are optional: same output with or without them
    expect(await frontLoad({ ws, checks })).toBe(fl);
  });

  it('counts tool schemas exactly once on both sides of the comparison', async () => {
    const system = systemPrompt({ task: GREENFIELD, checks, tools });
    const fl = await frontLoad({ ws, checks, tools });
    const req = { messages: [], tools, maxOutputTokens: 1 };
    const actual = countRequest({ ...req, system });
    const baseline = countRequest({ ...req, system: `${system}\n\n${fl}` });
    const withoutTools = countRequest({ ...req, tools: [], system: `${system}\n\n${fl}` }) - countRequest({ ...req, tools: [], system });
    expect(baseline - actual).toBe(withoutTools);
    expect(BASELINE_DEFINITION).toMatch(/tool schemas counted once/);
  });

  it('standardDoc and the system prompt index fall back when doc / description are missing', () => {
    expect(standardDoc(full)).toBe('FULL DOC TEXT');
    expect(standardDoc(described)).toBe('ORM ONE LINE');
    expect(standardDoc(bare)).toBe('lint-rule');
    const sp = systemPrompt({ task: GREENFIELD, checks, tools });
    expect(sp).toContain('- zod-boundary: one line');
    expect(sp).toContain('- orm-rule: ORM ONE LINE');
    expect(sp).toContain('- lint-rule: lint-rule');
    expect(sp).not.toContain('undefined');
    expect(sp).not.toContain('FULL DOC TEXT');
  });
});
