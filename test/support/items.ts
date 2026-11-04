/**
 * Test support for backlog items: a complete contract and a stakeholder yes recorded through the
 * same functions the CLI uses (proposeItem, then recordReply on the 'tty' channel, i.e. what the
 * terminal reader records when a person types). Tests never touch the committed docs/contracts/
 * and items/: the setup file points HARNESS_ITEMS_ROOT at a temp directory.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { itemPaths, proposeItem, recordReply } from '../../src/core/items.ts';

export function contractFor(slug: string, overrides: Record<string, string> = {}): string {
  const f = {
    Problem: `Test fixture item ${slug}: the suite drives a governed run through it.`,
    Owner: 'harness test suite',
    Stakeholder: 'Test Stakeholder',
    Repo: 'fixture/repo',
    Base: 'main',
    Commit: `test(fixture): drive a governed run through ${slug}`,
    Metric: 'fixture metric, one run before: ____ after: ____',
    Measure: 'node metrics/fixture-zero.mjs',
    Scenario: 'WHEN the run finishes THEN its gates decide',
    'Not included': 'anything outside the fixture',
    ...overrides,
  };
  return `# ${slug}\n\n${Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
}

/** Write the contract (unless `contract` is null) without proposing it. */
export function writeContract(root: string, slug: string, contract: string | null = contractFor(slug)): void {
  const paths = itemPaths(root, slug);
  if (contract === null) return;
  mkdirSync(dirname(paths.contract), { recursive: true });
  writeFileSync(paths.contract, contract);
}

/** Contract + proposal + a typed "yes" on the terminal channel: an editable item. */
export function approveForTest(root: string, slug: string, contract: string = contractFor(slug)): void {
  writeContract(root, slug, contract);
  proposeItem(root, slug, { session: 'test-setup', before: null });
  recordReply(root, slug, 'yes, approved', 'tty', 'test-setup');
}
