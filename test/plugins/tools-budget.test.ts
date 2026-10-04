/**
 * The tool list rides in EVERY request (actual and baseline alike), so it is part of the
 * per-turn floor. Shipped tools keep one short sentence each and terse field notes; paths are
 * declared API-relative once, in the system prompt.
 *
 * The budget applies to the SHIPPED tools only (an explicit list), never to whatever the
 * registry discovers: a tool someone drops into plugins/ later is theirs to size, and must
 * not turn `npm run verify` red.
 */
import { describe, expect, it } from 'vitest';
import { countText } from '../../plugins/lib/tokenize.ts';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { systemPrompt } from '../../src/core/prompt.ts';
import { loadRegistry, toolSpecs } from '../../src/core/registry.ts';
import { GREENFIELD } from '../core-loop/fakes.ts';
import { SHIPPED_TOOLS, shippedOnly } from '../token-efficiency/shipped.ts';

/** Every `description` string anywhere in a JSON schema. */
function fieldDescriptions(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(fieldDescriptions);
  if (typeof v !== 'object' || v === null) return [];
  return Object.entries(v).flatMap(([k, x]) => (k === 'description' && typeof x === 'string' ? [x] : fieldDescriptions(x)));
}

describe('tool list token budget', async () => {
  const shipped = shippedOnly(await loadRegistry(loadConfig(HARNESS_ROOT), HARNESS_ROOT)).tools;

  it('ships one short sentence per tool and terse field notes', () => {
    expect(shipped.map((r) => r.plugin.name).sort()).toEqual([...SHIPPED_TOOLS]);
    for (const r of shipped) expect(r.file, r.plugin.name).toBe(`plugins/tools/${r.plugin.name}.ts`);
    for (const { plugin } of shipped) {
      const d = plugin.description ?? '';
      expect(d.length, plugin.name).toBeGreaterThan(0);
      expect(d.length, `${plugin.name}: ${d}`).toBeLessThanOrEqual(100);
      expect(d.split(/[.;]\s/).length, `${plugin.name}: one sentence`).toBeLessThanOrEqual(2);
    }
    for (const spec of toolSpecs(shipped, 'brownfield')) {
      for (const f of fieldDescriptions(spec.inputSchema)) {
        expect(f.length, `${spec.name}: ${f}`).toBeLessThanOrEqual(40);
        expect(f, spec.name).not.toMatch(/API root/);
      }
    }
  });

  it('keeps the whole tool list within budget, and paths are declared API-relative once in the system prompt', () => {
    const green = countText(JSON.stringify(toolSpecs(shipped, 'greenfield')));
    const brown = countText(JSON.stringify(toolSpecs(shipped, 'brownfield')));
    // measured: 816 / 850 tokens before the trim, 697 / 726 after
    // 13 tools measured 697; append_file (added after real runs: models rewrote whole test files and were
    // refused by test-preservation) costs ~66 more. The budget catches bloat, not one justified tool.
    // delete_file (so a model can remove the scratch files it created; the orphans gate asks for it)
    // measured +37 tokens on both lists (763 -> 800, 792 -> 829): the budget rises by exactly that.
    expect(green).toBeLessThanOrEqual(780 + 37);
    expect(brown).toBeLessThanOrEqual(810 + 37);
    const tools = toolSpecs(shipped, 'greenfield');
    expect(systemPrompt({ task: GREENFIELD, checks: [], tools })).toMatch(/paths are relative to the API root/);
  });
});
