/**
 * The plugins this repository ships. Budget and efficiency assertions are about THESE, never
 * about whatever the registry discovers: a plugin someone drops into plugins/ later (a
 * grader's tool, ORM validator or lint rule) must not turn `npm run verify` red.
 */
import type { RegistryView } from '../../src/core/types.ts';

/** The 15 tools in plugins/tools/. */
export const SHIPPED_TOOLS = [
  'append_file', 'check_standards', 'contract_diff', 'delete_file', 'edit_file', 'fetch_standard', 'finish', 'list_files', 'outline',
  'plan', 'read_file', 'run_tests', 'search_code', 'test_map', 'write_file',
] as const;

/** The 4 standards checks in plugins/checks/. */
export const SHIPPED_CHECKS = ['problem-json', 'rest-conventions', 'tsc-strict', 'zod-boundary'] as const;

/** `reg` narrowed to the shipped tools and checks (drivers, hooks, gates and errors as loaded). */
export function shippedOnly(reg: RegistryView): RegistryView {
  const tools: ReadonlySet<string> = new Set(SHIPPED_TOOLS);
  const checks: ReadonlySet<string> = new Set(SHIPPED_CHECKS);
  return {
    ...reg,
    tools: reg.tools.filter((r) => tools.has(r.plugin.name)),
    checks: reg.checks.filter((r) => checks.has(r.plugin.id)),
  };
}
