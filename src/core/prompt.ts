/**
 * Provider-neutral prompts.
 *
 * systemPrompt  ~1.7 KB: role, completion contract, hook-enforced rules, workflow, how to
 *               fetch context, and a one-line-per-rule index (descriptions come from the
 *               check registry, so a new rule plugin shows up automatically).
 * taskBrief     the first user message: the task, compactly, plus a compact file tree (and, for
 *               greenfield, the scaffold's exported signatures: scaffoldApi).
 * frontLoad     BASELINE ONLY: what a non-JIT harness would front-load (every text file under
 *               the API root, every standards doc in full), exactly as tokens.ts
 *               BASELINE_DEFINITION states. Tool schemas are NOT repeated here: both requests
 *               already carry them in their tools array. Used for the shadow baseline and --baseline.
 */
import type { CheckPlugin, FieldSpec, ResourceSpec, Task, TestMap, ToolSpec, Workspace } from './types.ts';

const CONTEXT_TOOLS = ['list_files', 'read_file', 'outline', 'search_code', 'test_map', 'fetch_standard'];

export function systemPrompt(opts: { task: Task; checks: CheckPlugin[]; tools: ToolSpec[] }): string {
  const have = new Set(opts.tools.map((t) => t.name));
  const fetchers = CONTEXT_TOOLS.filter((n) => have.has(n)).map((n) => {
    if (n === 'read_file') return 'read_file (line ranges)';
    if (n === 'fetch_standard') return 'fetch_standard <rule>';
    return n;
  });
  const lines = [
    'You implement TypeScript REST APIs (Express 5, Zod 4, Vitest) in a governed harness, acting only through tools; paths are relative to the API root.',
    '',
    'You are done only when the deterministic gates (tests, observed red, standards, scope, contract) pass; finish runs them. If finish is refused, fix what the gate lines name and call finish again.',
    '',
    'Hooks block, with a reason (adapt, do not retry blindly):',
    '- editing a src/ file before a test covering it ran and failed (red);',
    '- writes outside the allowed .ts files (config, package files, read-only helpers);',
    '- `any`, non-null assertions, ts-ignore / ts-expect-error / ts-nocheck.',
    '',
    'Workflow: plan -> write test -> run_tests (red) -> implement -> run_tests (green) -> check_standards -> finish.',
    '',
    `Nothing is preloaded; fetch on demand: ${fetchers.join(', ') || 'the provided tools'}. Do not re-read files you just wrote unless you need their exact text. In history your large inputs are omitted and older turns become a one-line-per-call digest; re-run a tool to see more. Independent calls may share a turn.`,
  ];
  if (opts.checks.length > 0) {
    lines.push('', 'Standards (fetch_standard <rule> for the full text):');
    for (const c of opts.checks) lines.push(`- ${c.id}: ${c.description ?? c.id}`);
  }
  return lines.join('\n');
}

// ───────────────────────────── task brief ─────────────────────────────

export function fieldLine(f: FieldSpec): string {
  const bits: string[] = [f.type === 'enum' && f.values !== undefined ? `enum [${f.values.join('|')}]` : f.type];
  if (f.required) bits.push('required');
  if (f.unique) bits.push('unique');
  if (f.readOnly) bits.push('read-only');
  if (f.min !== undefined) bits.push(`min ${f.min}`);
  if (f.max !== undefined) bits.push(`max ${f.max}`);
  if (f.default !== undefined) bits.push(`default ${String(f.default)}`);
  const desc = f.description !== undefined ? ` (${f.description})` : '';
  return `${f.name}: ${bits.join(', ')}${desc}`;
}

function resourceBlock(r: ResourceSpec): string[] {
  return [
    `Resource ${r.name} (plural ${r.plural}); server-managed id (uuid), createdAt, updatedAt (datetime) are implied.`,
    ...r.fields.map(fieldLine),
    `operations: ${r.operations.join(', ')}`,
  ];
}

/** Scaffold files whose exported signatures go into the greenfield brief. */
export const SCAFFOLD_API_GLOBS = ['src/lib/**/*.ts', 'src/app.ts', 'src/routes/index.ts'];

/**
 * Exported signatures of scaffold files, one `path:line  export …` line each (bodies and
 * trailing `{` dropped): the model learns the helper API from a few hundred characters instead
 * of reading every scaffold file up front.
 */
export function scaffoldApi(files: Array<{ path: string; content: string }>): string {
  const out: string[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    f.content.split('\n').forEach((l, i) => {
      if (!/^export\b/.test(l)) return;
      const sig = l.length > 150 ? `${l.slice(0, 150)}…` : l.replace(/\s*\{\s*$/, '').replace(/\($/, '(…)');
      out.push(`${f.path}:${i + 1}  ${sig}`);
    });
  }
  return out.join('\n');
}

/** scaffoldApi over the SCAFFOLD_API_GLOBS files of a workspace. */
export async function scaffoldApiOf(ws: Workspace): Promise<string> {
  const files: Array<{ path: string; content: string }> = [];
  for (const path of await ws.list(SCAFFOLD_API_GLOBS)) {
    const content = await ws.read(path);
    if (content !== null) files.push({ path, content });
  }
  return scaffoldApi(files);
}

export function taskBrief(task: Task, extras: { tree: string; testMap?: string; scaffoldApi?: string }): string {
  const out: string[] = [`Task ${task.id} (${task.kind}): ${task.title}`];
  if (task.kind === 'greenfield') {
    out.push(`Base path: ${task.basePath}`, '');
    for (const r of task.resources) out.push(...resourceBlock(r), '');
  } else {
    out.push('', 'Change:', task.change.trim(), '');
  }
  if (task.behaviours.length > 0) {
    out.push(task.kind === 'greenfield' ? 'Behaviours:' : 'Acceptance criteria:');
    for (const b of task.behaviours) out.push(`- ${b}`);
    out.push('');
  }
  if (task.kind === 'greenfield') {
    out.push(
      'Scaffold: read-only helpers in src/lib to use (do not edit): problem.ts (HttpProblem, notFound, conflict, unprocessable, badRequest), errors.ts (errorHandler, notFoundHandler), pagination.ts (CursorQuerySchema, paginate, pageSchema), idempotency.ts (idempotency() middleware for POST/PATCH).',
      'Mount routers in src/routes/index.ts (registerRoutes). Tests live in test/*.test.ts and use supertest against createApp() from src/app.ts.',
      'Every createApp() call must start with empty state: create stores inside the function that builds/registers the router (called per app), never at module level, so tests stay independent.',
      '',
    );
    if (extras.scaffoldApi !== undefined && extras.scaffoldApi.length > 0) {
      out.push('Scaffold API (exported signatures; read_file a line range only when you need a body):', extras.scaffoldApi, '');
    }
  } else {
    out.push(`Scope: allow ${task.scope.allow.join(', ') || '(none)'}; deny ${task.scope.deny.join(', ') || '(none)'}`);
    out.push(
      task.allowBreaking
        ? 'Breaking contract changes: allowed for this task (allowBreaking).'
        : 'Breaking contract changes: refused (contract lock); check with contract_diff before finish.',
    );
    if (extras.testMap !== undefined && extras.testMap.length > 0) out.push('', 'Test map (test -> covered src):', extras.testMap);
    out.push('');
  }
  out.push('Files:', extras.tree);
  return out.join('\n');
}

/** Compact file tree: one line per directory, at most `maxLines` lines. */
export function compactTree(paths: string[], maxLines = 60): string {
  const dirs = new Map<string, string[]>();
  for (const p of [...paths].sort()) {
    const i = p.lastIndexOf('/');
    const dir = i === -1 ? '.' : p.slice(0, i);
    const base = i === -1 ? p : p.slice(i + 1);
    const list = dirs.get(dir);
    if (list === undefined) dirs.set(dir, [base]);
    else list.push(base);
  }
  const lines: string[] = [];
  for (const [dir, files] of dirs) {
    let line = `${dir}/: `;
    let shown = 0;
    for (const f of files) {
      const next = shown === 0 ? f : `, ${f}`;
      if (line.length + next.length > 160) break;
      line += next;
      shown += 1;
    }
    if (shown < files.length) line += ` … +${files.length - shown}`;
    lines.push(line);
  }
  if (lines.length <= maxLines) return lines.join('\n');
  const kept = lines.slice(0, maxLines - 1);
  kept.push(`… ${lines.length - kept.length} more directories (use list_files)`);
  return kept.join('\n');
}

/** Compact test map: `test -> src, src` lines (capped). */
export function testMapSummary(map: TestMap, maxLines = 30): string {
  const entries = Object.entries(map.coverage).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const lines = entries.slice(0, maxLines).map(([t, srcs]) => `${t} -> ${srcs.length > 0 ? srcs.join(', ') : '(no src)'}`);
  if (entries.length > maxLines) lines.push(`… ${entries.length - maxLines} more test files (use test_map)`);
  return lines.join('\n');
}

// ───────────────────────────── baseline front-load ─────────────────────────────

const FRONT_LOAD_CAP = 200 * 1024;

/** Full text of a standard: its doc, else its one-line description, else its id. */
export function standardDoc(c: CheckPlugin): string {
  return c.doc ?? c.description ?? c.id;
}

export async function frontLoad(opts: {
  ws: Workspace;
  checks: CheckPlugin[];
  /** Accepted for call-site compatibility and ignored: tool schemas are in every request's tools array. */
  tools?: ToolSpec[];
}): Promise<string> {
  const files = (await opts.ws.list(['**/*'])).filter((p) => !/(^|\/)(node_modules|\.git|dist)(\/|$)/.test(p)).sort();
  const parts: string[] = ['Repository contents:'];
  let total = 0;
  let skipped = 0;
  for (const f of files) {
    const content = await opts.ws.read(f);
    if (content === null || content.includes('\u0000')) continue;
    if (total + content.length > FRONT_LOAD_CAP) {
      skipped += 1;
      continue;
    }
    total += content.length;
    parts.push(`=== ${f} ===`, content);
  }
  if (skipped > 0) parts.push(`=== (${skipped} more files omitted: 200 KB cap) ===`);
  parts.push('', 'Standards:');
  for (const c of opts.checks) parts.push(`=== standard: ${c.id} ===`, standardDoc(c));
  return parts.join('\n');
}
