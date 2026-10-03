/**
 * Run-start content of the API's TypeScript files, kept as content-addressed blobs under
 * <runDir>/initial/<sha256> (outside the worktree, so agent code never writes them).
 * The observed-red gate's revert check puts these back in a scratch copy of the API to prove
 * that a red -> green flip was caused by the source change.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TS_FILE = /\.[cm]?ts$/;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Store the content of every TypeScript file among `files` (API-relative path -> content). */
export async function saveInitial(runDir: string, files: ReadonlyMap<string, string>): Promise<void> {
  const dir = join(runDir, 'initial');
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of files) {
    if (!TS_FILE.test(rel)) continue;
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
