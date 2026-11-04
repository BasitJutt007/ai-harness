/**
 * Every governed run is bound to a backlog item whose contract the stakeholder approved in a typed
 * turn (assignment 02). The suite gets its own items root with the fixture tasks approved, so no
 * test writes into the committed docs/contracts/ or items/.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveForTest } from '../support/items.ts';

/** Task ids the run-driving tests use (tasks/*.task.yaml and the free-text fixture). */
export const FIXTURE_ITEMS = ['users-api', 'projects-change', 'delete-and-filter'];

if (process.env['HARNESS_ITEMS_ROOT'] === undefined) {
  const root = mkdtempSync(join(tmpdir(), 'harness-items-'));
  process.env['HARNESS_ITEMS_ROOT'] = root;
  for (const slug of FIXTURE_ITEMS) approveForTest(root, slug);
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
}
