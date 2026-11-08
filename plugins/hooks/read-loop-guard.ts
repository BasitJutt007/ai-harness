/**
 * read-loop-guard (post, read_file and every write): notices a model that keeps re-reading a file
 * instead of changing it. History keeps only the most recent turns in full, so a long file read in
 * ranges never stays in view at once; a model that waits to "see it all" before editing reads the
 * same file again and again until the turn limit (a private item's run read one 443-line screen 45
 * times in 60 turns and never edited it). From the third read of the same file since the run's last
 * write, the read result carries a note: the file has been read N times since the last write, the
 * lines it needs are in this result, and edit_file changes an exact snippet without seeing the
 * whole file. A successful write clears the count.
 *
 * It only records, never blocks: reading is never wrong, and the gates decide at finish.
 */
import { defineHook } from '../../src/core/plugin-api.ts';

/** The read of one file (since the last write) from which the note is added. */
export const NOTE_FROM_READ = 3;

/** Per run: reads per API-relative path since the run's last successful write. */
const reads = new Map<string, Map<string, number>>();

function readPath(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const p = (data as { path?: unknown }).path;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

export function readLoopNote(path: string, count: number): string {
  return `read-loop: ${path} has been read ${count} times since your last write. Re-reading will not keep the whole file in view (only the latest turns stay in full). The lines you need are in this result: change them now with edit_file (it replaces an exact snippet, so it needs only those lines), then read again only what the edit touched.`;
}

export default defineHook({
  name: 'read-loop-guard',
  description: 'Notes, on the third and later reads of the same file since the last write, that the model should edit instead of re-reading (post-tool; never blocks).',
  events: ['post_tool'],
  async run(event, ctx) {
    if (event.event !== 'post_tool' || !event.result.ok) return { decision: 'pass' };
    const runId = ctx.run.id;
    if (event.call.effect === 'write') {
      reads.delete(runId);
      return { decision: 'pass' };
    }
    if (event.call.tool !== 'read_file') return { decision: 'pass' };
    const path = readPath(event.result.data);
    if (path === null) return { decision: 'pass' };
    let perRun = reads.get(runId);
    if (perRun === undefined) {
      perRun = new Map();
      reads.set(runId, perRun);
    }
    const count = (perRun.get(path) ?? 0) + 1;
    perRun.set(path, count);
    return count >= NOTE_FROM_READ ? { decision: 'record', note: readLoopNote(path, count) } : { decision: 'pass' };
  },
});
