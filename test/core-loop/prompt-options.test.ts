/**
 * The model sees what each rule was configured with (harness.config.json checkOptions): a rule's text
 * names its options by key (adminDecorators), but the code must carry their values (@AdminOnly()). So
 * the rules index of the system prompt, fetch_standard and the baseline front-load all show a
 * configured rule's options; a rule with none reads exactly as before (the twin).
 */
import { describe, expect, it } from 'vitest';
import nestRouteGuard from '../../plugins/checks/nest-route-guard.ts';
import fetchStandard from '../../plugins/tools/fetch_standard.ts';
import { frontLoad, optionsSummary, standardDoc, systemPrompt } from '../../src/core/prompt.ts';
import type { CheckPlugin, RunContext, Workspace } from '../../src/core/types.ts';
import { CONFIG, fakeCtx, GREENFIELD } from './fakes.ts';

const OPTIONS = { 'nest-route-guard': { adminDecorators: ['AdminOnly', 'RequireAdmin'], publicDecorators: ['Public'] } };
const plain: CheckPlugin = { kind: 'check', id: 'plain', category: 'lint', description: 'A plain rule.', doc: 'PLAIN DOC', run: async () => [] };
const emptyWs = { list: async () => [], read: async () => null } as unknown as Workspace;

describe('a rule\'s configured options reach the model', () => {
  it('optionsSummary renders keys and values; nothing for a rule without an entry', () => {
    expect(optionsSummary('nest-route-guard', OPTIONS)).toBe('adminDecorators: AdminOnly, RequireAdmin; publicDecorators: Public');
    expect(optionsSummary('plain', OPTIONS)).toBe('');
    expect(optionsSummary('nest-route-guard', undefined)).toBe('');
    expect(optionsSummary('x', { x: { names: [], limit: 3, mode: 'strict' } })).toBe('names: (none); limit: 3; mode: strict');
  });

  it('the rules index of the system prompt shows them next to the rule', () => {
    const sp = systemPrompt({ task: GREENFIELD, checks: [nestRouteGuard, plain], tools: [], checkOptions: OPTIONS });
    expect(sp).toContain('- nest-route-guard: Admin-facing routes carry an admin decorator; no route carries a public decorator unless the contract names it (names from checkOptions). (configured: adminDecorators: AdminOnly, RequireAdmin; publicDecorators: Public)');
    expect(sp).toMatch(/^- plain: A plain rule\.$/m);
    // the twin: without checkOptions the index is as before
    expect(systemPrompt({ task: GREENFIELD, checks: [nestRouteGuard], tools: [] })).not.toContain('configured:');
  });

  it('standardDoc and the baseline front-load append them to the rule\'s full text', async () => {
    expect(standardDoc(nestRouteGuard, OPTIONS)).toMatch(/\nConfigured for this repository \(harness\.config\.json checkOptions\["nest-route-guard"\]\): adminDecorators: AdminOnly, RequireAdmin; publicDecorators: Public$/);
    expect(standardDoc(plain, OPTIONS)).toBe('PLAIN DOC');
    const fl = await frontLoad({ ws: emptyWs, checks: [nestRouteGuard, plain], checkOptions: OPTIONS });
    expect(fl).toContain('adminDecorators: AdminOnly, RequireAdmin');
    expect(await frontLoad({ ws: emptyWs, checks: [nestRouteGuard] })).not.toContain('Configured for this repository');
  });

  it('fetch_standard shows them (read from the run\'s config)', async () => {
    const base = fakeCtx().ctx;
    const ctx: RunContext = {
      ...base,
      config: { ...CONFIG, checkOptions: OPTIONS },
      registry: { ...base.registry, checks: [{ plugin: nestRouteGuard, file: 'plugins/checks/nest-route-guard.ts', sha256: '0' }, { plugin: plain, file: 'p.ts', sha256: '0' }] },
    };
    const r = await fetchStandard.run({ rule: 'nest-route-guard' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('Configured for this repository (harness.config.json checkOptions["nest-route-guard"]): adminDecorators: AdminOnly, RequireAdmin; publicDecorators: Public');
    expect((await fetchStandard.run({ rule: 'plain' }, ctx)).summary).toBe('plain (lint, unit: units)\nPLAIN DOC');
  });
});
