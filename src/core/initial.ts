/**
 * Run-start content of the API's code files, kept as content-addressed blobs under
 * <runDir>/initial/<sha256> (outside the worktree, so agent code never writes them).
 * The observed-red gate's revert check puts these back in a scratch copy of the API to prove
 * that a red -> green flip was caused by the source change.
 *
 * Every kind the observed-red rule can govern is kept: TypeScript with and without JSX (a React
 * target's .tsx is governed in file mode, and its revert check needs the run-start content), and the
 * JavaScript and component kinds an in-place web layout governs. Keeping a blob the gate never asks
 * for costs nothing; missing one turns a proof into UNPROVEN.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Store the content of every code file among `files` (API-relative path -> content). */
export async function saveInitial(runDir: string, files: ReadonlyMap<string, string>): Promise<void> {
  const dir = join(runDir, 'initial');
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of files) {
    if (!CODE_FILE.test(rel)) continue;
    const blob = join(dir, sha256(content));
    if (!existsSync(blob)) await writeFile(blob, content, 'utf8');
  }
}

/** The stored content with this hash (verified), or null. */
export async function readInitial(runDir: string, hash: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const content = await readFile(join(runDir, 'initial', hash), 'utf8').catch(() => null);
  return content !== null && sha256(content) === hash ? content : null;
}
