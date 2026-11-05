/**
 * The gates' source files run on their own. A plugin or the outcome check acts only inside the harness
 * (a run, `harness item close`); run directly (`node <file>`, `tsx <file>`) such a file used to exit 0
 * in silence, which reads as a pass. Instead it prints how to check that gate (`harness gate ...`) and
 * exits 2. Imported by the registry or the CLI, it does nothing.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Whether the module at `moduleUrl` (its import.meta.url) is the program being run, not an import. False when it cannot tell. */
export function isMainModule(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** Run directly: print `pointer` and set exit code 2 (returns true). Imported: nothing (returns false). */
export function pointWhenRunDirectly(moduleUrl: string, pointer: string, argv: readonly string[] = process.argv): boolean {
  if (!isMainModule(moduleUrl, argv)) return false;
  process.stdout.write(`${pointer}\n`);
  process.exitCode = 2;
  return true;
}
