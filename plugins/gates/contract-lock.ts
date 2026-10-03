/**
 * contract-lock (brownfield; our own addition): the API's public contract must
 * not break versus the base commit unless the task explicitly allows it.
 * Extraction failure or an unprovable change is UNPROVEN, never pass: a schema
 * whose shape cannot be extracted, a source change JSON Schema cannot show
 * (.refine), validation that moved out of sight, a POST/PUT/PATCH body read
 * without an extractable schema. Breaking = routes, request/response schemas
 * (constraint keywords included) and new 4xx statuses (see plugins/lib/contract.ts);
 * informational changes (a removed error status, a response default) never block.
 */
import { defineGate } from '../../src/core/plugin-api.ts';
import { compareWithBase, formatDiff } from '../lib/contract.ts';
import type { BaseComparison, Change } from '../lib/contract.ts';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const line = (c: Change): string => `${c.location}  ${c.message}`;

export default defineGate({
  name: 'contract-lock',
  description: 'No breaking change to the public API contract (routes, request and response schemas, new 4xx statuses) versus the base commit.',
  phases: ['finish', 'ship'],
  appliesTo: ['brownfield'],
  async run(ctx) {
    if (ctx.task.kind !== 'brownfield') return { status: 'n/a', summary: 'not applicable to greenfield tasks' };
    let cmp: BaseComparison;
    try {
      cmp = await compareWithBase(ctx);
    } catch (e) {
      return { status: 'unproven', summary: `contract extraction failed: ${errMsg(e)}` };
    }
    const { before, after, diff } = cmp;
    await ctx.logs.write('contract-before.json', JSON.stringify(before, null, 2));
    await ctx.logs.write('contract-after.json', JSON.stringify(after, null, 2));
    const lines = formatDiff(diff, 1000);
    const warnings = [...new Set([...before.warnings, ...after.warnings])];
    const logPath = await ctx.logs.write(
      'contract-diff.txt',
      [...lines, ...(warnings.length > 0 ? ['', 'warnings:', ...warnings.map((w) => `  ${w}`)] : [])].join('\n') || 'no changes',
    );
    const counts = `${before.endpoints.length} → ${after.endpoints.length} endpoints`;
    const info = diff.informational.length > 0 ? `; ${diff.informational.length} informational` : '';

    if (before.endpoints.length === 0 && after.endpoints.length === 0) {
      return { status: 'unproven', summary: 'no routes found on either side; the contract cannot be proven', logPath };
    }
    if (diff.breaking.length > 0 && !ctx.task.allowBreaking) {
      return {
        status: 'fail',
        summary: `${diff.breaking.length} breaking contract changes (${counts}); set allowBreaking only if intended`,
        details: [...diff.breaking.map(line), ...diff.unproven.map((c) => `unproven: ${line(c)}`)],
        logPath,
      };
    }
    if (diff.unproven.length > 0) {
      return {
        status: 'unproven',
        summary: `${diff.unproven.length} contract changes could not be proven (${counts}): ${[...new Set(diff.unproven.map((c) => c.location))].slice(0, 3).join(', ')}${diff.unproven.length > 3 ? ', …' : ''}`,
        details: diff.unproven.map(line),
        logPath,
      };
    }
    const additive = diff.additive.length === 0
      ? 'no additive changes'
      : `${diff.additive.length} additive (${diff.additive.slice(0, 3).map((c) => `${c.location}: ${c.message}`).join('; ')}${diff.additive.length > 3 ? '; …' : ''})`;
    const allowed = diff.breaking.length > 0 ? `${diff.breaking.length} breaking changes allowed by task; ` : '';
    const details = [
      ...diff.breaking.map((c) => `allowed: ${line(c)}`),
      ...diff.informational.map((c) => `informational: ${line(c)}`),
    ];
    return {
      status: 'pass',
      summary: `contract preserved (${counts}, via ${after.extractedWith}): ${allowed}${additive}${info}`,
      ...(details.length > 0 ? { details } : {}),
      logPath,
    };
  },
});
