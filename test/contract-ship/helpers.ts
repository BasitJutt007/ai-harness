import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HARNESS_ROOT, loadConfig } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { newRunState } from '../../src/core/run-store.ts';
import { createWorkspace } from '../../src/core/workspace.ts';
import type {
  BrownfieldTask, Exec, GatePlugin, GateResult, GreenfieldTask, LogStore, PluginRecord, RegistryView, RunContext,
} from '../../src/core/types.ts';

/** Temp dir INSIDE the repo (.harness/tmp is gitignored) so node_modules resolution works. */
export function repoTmp(label: string): { dir: string; cleanup: () => void } {
  const dir = join(HARNESS_ROOT, '.harness', 'tmp', `contract-ship-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** exec with git isolated from the user's global/system config (no signing, no global hooks). */
export const isolatedExec: Exec = (cmd, args, opts) =>
  exec(cmd, args, { ...opts, env: { ...process.env, ...opts.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await isolatedExec('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

// ───────────────────────────── a small Express + Zod API ─────────────────────────────

export const SCHEMAS = `import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['active', 'archived']),
  description: z.string().optional(),
});
export const ListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['active', 'archived']).optional(),
});
export const CreateProjectSchema = z.object({ name: z.string().min(1) });
export const ProjectParamsSchema = z.object({ projectId: z.string() });
export const ProjectPageSchema = z.object({ data: z.array(ProjectSchema), nextCursor: z.string().nullable() });
`;

export const ROUTES = `import { Router } from 'express';
import { z } from 'zod';
import { CreateProjectSchema, ListQuerySchema, ProjectPageSchema, ProjectParamsSchema, ProjectSchema } from '../schemas.js';

type Project = z.infer<typeof ProjectSchema>;
const store: Project[] = [];
const LocalHeaders = z.object({ 'x-trace': z.string().optional() });

export const projectsRouter = Router();

projectsRouter.get('/v1/projects', (req, res) => {
  const q = ListQuerySchema.parse(req.query);
  const data = store.filter((p) => q.status === undefined || p.status === q.status);
  res.json(ProjectPageSchema.parse({ data, nextCursor: null }));
});

projectsRouter.post('/v1/projects', (req, res) => {
  LocalHeaders.parse(req.headers);
  const body = CreateProjectSchema.parse(req.body);
  const p: Project = { id: String(store.length + 1), name: body.name, status: 'active' };
  store.push(p);
  res.status(201).json(ProjectSchema.parse(p));
});

projectsRouter.get('/v1/projects/:projectId', (req, res) => {
  const { projectId } = ProjectParamsSchema.parse(req.params);
  const p = store.find((x) => x.id === projectId);
  if (p === undefined) {
    res.status(404).end();
    return;
  }
  res.json(ProjectSchema.parse(p));
});

projectsRouter.delete('/v1/projects/:projectId', (req, res) => {
  ProjectParamsSchema.parse(req.params);
  res.status(204).end();
});
`;

export function apiFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'projects-api', type: 'module', private: true }, null, 2),
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
        noUncheckedIndexedAccess: true, types: ['node'], noEmit: true, skipLibCheck: true,
      },
      include: ['src', 'test'],
    }, null, 2),
    'src/schemas.ts': SCHEMAS,
    'src/routes/projects.ts': ROUTES,
    ...overrides,
  };
}

// ───────────────────────────── run context ─────────────────────────────

export function brownfieldTask(over: Partial<BrownfieldTask> = {}): BrownfieldTask {
  return {
    kind: 'brownfield', id: 'projects-change', title: 'Projects change', behaviours: [],
    limits: { maxTurns: 10, maxOutputTokens: 1000 }, target: 'api', change: 'x',
    scope: { allow: ['src/**/*.ts', 'test/**/*.ts'], deny: [] }, allowBreaking: false, ...over,
  };
}

export function greenfieldTask(): GreenfieldTask {
  return {
    kind: 'greenfield', id: 'users-api', title: 'Users API', behaviours: [], limits: { maxTurns: 10, maxOutputTokens: 1000 },
    output: 'api', template: 'express-zod', basePath: '/v1', resources: [],
  };
}

export function memoryLogs(): LogStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    write(name: string, content: string): Promise<string> {
      files.set(name, content);
      return Promise.resolve(`runs/test/logs/${name}`);
    },
  };
}

export function stubGate(name: string, result: GateResult): PluginRecord<GatePlugin> {
  return {
    plugin: { kind: 'gate', name, description: name, phases: ['finish', 'ship'], run: () => Promise.resolve(result) },
    file: `plugins/gates/${name}.ts`,
    sha256: 'x',
  };
}

export function registryWith(gates: PluginRecord<GatePlugin>[]): RegistryView {
  return { drivers: [], tools: [], hooks: [], gates, checks: [], errors: [] };
}

export function makeCtx(opts: {
  repoRoot: string; rootRel: string; task: BrownfieldTask | GreenfieldTask; branch: string; baseBranch: string; baseSha: string;
  exec?: Exec; gates?: PluginRecord<GatePlugin>[]; runDir?: string;
}): RunContext & { logs: ReturnType<typeof memoryLogs> } {
  const logs = memoryLogs();
  const registry = registryWith(opts.gates ?? []);
  const fail = (): Promise<never> => Promise.reject(new Error('not available in this test'));
  return {
    run: {
      id: 'projects-change-scripted-20261002-120000', driver: 'scripted', model: 'none', startedAt: new Date().toISOString(),
      harnessRoot: HARNESS_ROOT, runDir: opts.runDir ?? join(opts.repoRoot, 'no-run-dir'), branch: opts.branch,
      baseBranch: opts.baseBranch, baseSha: opts.baseSha,
    },
    task: opts.task,
    workspace: createWorkspace(opts.repoRoot, opts.rootRel),
    state: newRunState(),
    logs,
    mode: { jit: true, compactReturns: true, compactHistory: true },
    config: loadConfig(),
    exec: opts.exec ?? isolatedExec,
    services: { runTests: fail, runChecks: fail, testMap: fail, runTestsReverted: fail },
    registry,
    emit: () => undefined,
  };
}
