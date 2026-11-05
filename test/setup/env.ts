/**
 * No test reads the owner's ~/.sf-harness: the env file the harness launcher loads (provider keys) and
 * the state home sessions write to both point at throwaway locations, here and in every child process
 * a test spawns (bin/harness.mjs inherits the environment). A test that needs either sets its own.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env['SF_HARNESS_ENV_FILE'] === undefined) {
  // A path that does not exist: the launcher loads nothing.
  process.env['SF_HARNESS_ENV_FILE'] = join(tmpdir(), `harness-test-no-env-file-${process.pid}-${Date.now()}`);
}
if (process.env['SF_HARNESS_HOME'] === undefined) {
  const home = mkdtempSync(join(tmpdir(), 'harness-state-home-'));
  process.env['SF_HARNESS_HOME'] = home;
  process.on('exit', () => rmSync(home, { recursive: true, force: true }));
}
