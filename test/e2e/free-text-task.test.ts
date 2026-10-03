/**
 * E2E: a task file in nobody's schema. A free-text Markdown change request (no kind, no target, no
 * keys at all) plus `--target <api dir>` drives a real governed brownfield run on a committed copy of
 * samples/existing-api. The front end's notes are printed before the first model call, the canonical
 * task is evidence (runs/<id>/task.normalized.json + normalizedSha256 in run.json), and reopening the
 * run (ship) uses that recorded task, not a re-read of the (since changed) task file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRun, openRun, type RunSummary } from '../../src/core/run.ts';
import { taskBrief } from '../../src/core/prompt.ts';
import { loadTask } from '../../src/core/task.ts';
import { collector, execWithoutGh, readRunJson, SAMPLE, SCRIPTS, tempRepo, type TempRepo } from './helpers.ts';

const CHANGE = `# Delete projects and filter the list by status

Add DELETE /v1/projects/{projectId} (204, or 404 problem+json when missing) and an optional
\`status\` query parameter on GET /v1/projects (active | archived), applied before the cursor
pagination. Existing routes and schemas must keep working: both changes are additive.
`;

let tmp: TempRepo;
let s: RunSummary;
let taskFile: string;
let target: string;
const log = collector();

beforeAll(async () => {
  tmp = tempRepo('free-text', { 'samples/existing-api': SAMPLE });
  taskFile = join(tmp.dir, 'delete-and-filter.md');
  writeFileSync(taskFile, CHANGE);
  target = join(tmp.repo, 'samples', 'existing-api');
  s = await executeRun({
    taskFile,
    target,
    driver: 'scripted',
    driverOptions: { script: join(SCRIPTS, 'projects-change.json') },
    baseline: false,
    ship: false,
    runsDir: tmp.runsDir,
    tokensDir: tmp.tokensDir,
    exec: execWithoutGh(),
    log: log.out,
  });
}, 300_000);
afterAll(() => tmp.cleanup());

describe('free-text brownfield task + --target', () => {
  it('the run is a governed brownfield change and finishes with every gate green', () => {
    expect(s.error).toBeUndefined();
    expect(s.status).toBe('done');
    expect(s.ok).toBe(true);
    expect(s.gates.find((g) => g.gate === 'contract-lock')?.status).toBe('pass');
  });

  it('the normalization notes are printed before anything else', () => {
    expect(log.lines[0]).toMatch(/^task {7}\d+ note\(s\) normalizing .*delete-and-filter\.md/);
    const notes = log.lines.slice(1, log.lines.findIndex((l) => l.startsWith('run ')));
    expect(notes.join('\n')).toMatch(/kind inferred: brownfield \(--target given\)/);
    expect(notes.join('\n')).toMatch(/target set by --target/);
  });

  it('task.normalized.json is evidence, and run.json records both shas', async () => {
    const normalized: unknown = JSON.parse(readFileSync(join(s.runDir, 'task.normalized.json'), 'utf8'));
    const loaded = await loadTask(taskFile, { target });
    expect(normalized).toMatchObject({ format: 'markdown', strict: false, sha256: loaded.sha256, normalizedSha256: loaded.normalizedSha256, warnings: loaded.warnings });
    expect(normalized).toMatchObject({ task: { kind: 'brownfield', id: 'delete-and-filter', title: 'Delete projects and filter the list by status', target } });
    const run = readRunJson(s.runDir);
    expect(run.task).toMatchObject({ sha256: loaded.sha256, normalizedSha256: loaded.normalizedSha256, format: 'markdown', strict: false });
    // the brief built from the recorded task carries the request verbatim
    expect(taskBrief(loaded.task, { tree: '' })).toContain(`Change:\n${CHANGE.trim()}\n`);
  });

  it('reopening the run uses the recorded task, even after the task file changed', async () => {
    const before = await loadTask(taskFile, { target });
    writeFileSync(taskFile, 'kind: greenfield\ntitle: Something else\nbrief: unrelated\n');
    const { ctx } = await openRun(s.runId, { runsDir: tmp.runsDir, tokensDir: tmp.tokensDir });
    expect(ctx.task).toEqual(before.task);
  });
});
