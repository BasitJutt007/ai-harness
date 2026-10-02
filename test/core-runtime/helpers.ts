import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../../src/core/config.ts';

/** Temp dir INSIDE the repo (.harness/tmp is gitignored) so node_modules resolution works. */
export function repoTmp(label: string): { dir: string; cleanup: () => void } {
  const dir = join(HARNESS_ROOT, '.harness', 'tmp', `core-runtime-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
