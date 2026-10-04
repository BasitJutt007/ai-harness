/**
 * Fail-closed audit: the shipped governed/users-api reads 100%; every mutation below either breaks a standard
 * or uses a construct the analysis does not model, so `harness check` must NOT read 100% on any of them
 * (FAIL or UNPROVEN only). A mutation that still passes is a bypass: fix the checker, never this list.
 *
 *   npm run audit:mutations
 *
 * Each case runs the full check (static rules and the runtime probes) on a copy, so this is slow (~10 s per
 * case) and kept out of `npm test`.
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = join(ROOT, 'governed', 'users-api');
const TMP = join(ROOT, '.harness', 'tmp', `mutations-${process.pid}`);
const USERS = 'src/routes/users.ts';
const APP = 'src/app.ts';

/** [file, exact text to find (must occur once), replacement]; a file absent from the API is created with the replacement. */
type Edit = [string, string, string];
interface Mutation {
  name: string;
  edits: Edit[];
}

const GET_ONE = 'res.json(UserSchema.parse(user));\n  });\n\n  router.post';
const getOne = (body: string): Edit => [USERS, GET_ONE, `${body}\n  });\n\n  router.post`];

const MUTATIONS: Mutation[] = [
  // ── plain violations ──
  { name: 'unparsed 2xx body', edits: [getOne('res.json(user);')] },
  { name: 'create answers 200', edits: [[USERS, '.status(201).json(UserSchema.parse(user))', '.status(200).json(UserSchema.parse(user))']] },
  { name: 'create without Location', edits: [[USERS, "res.location(`/v1/users/${user.id}`).status(201)", 'res.status(201)']] },
  { name: 'PATCH without idempotency', edits: [[USERS, "router.patch('/v1/users/:userId', idempotency(), ", "router.patch('/v1/users/:userId', "]] },
  { name: 'ad-hoc 404 body', edits: [[USERS, 'if (user === undefined) throw notFound(`User ${userId} was not found.`);\n    res.json', "if (user === undefined) {\n      res.status(404).json({ error: 'missing' });\n      return;\n    }\n    res.json"]] },
  { name: 'body changed after its parse', edits: [getOne("res.json(Object.assign(UserSchema.parse(user), { internal: 'x' }));")] },
  { name: 'unversioned path', edits: [[USERS, "router.get('/v1/users/:userId'", "router.get('/users/:userId'"]] },

  // ── responses the analysis does not model ──
  { name: 'res.redirect', edits: [getOne("res.redirect(302, '/v1/users');")] },
  { name: 'res.write + end', edits: [getOne('res.write(JSON.stringify(user));\n    res.end();')] },
  { name: 'res.sendFile', edits: [getOne("res.sendFile('/etc/hosts');")] },
  { name: 'res.format', edits: [getOne('res.format({ json: () => res.json(user) });')] },
  { name: 'statusCode assignment', edits: [getOne('res.statusCode = 299;\n    res.json(UserSchema.parse(user));')] },
  { name: 'computed res member', edits: [getOne("res['json'](UserSchema.parse(user));")] },
  { name: 'non-constant status', edits: [getOne('const code: number = user.name.length > 200 ? 500 : 200;\n    res.status(code).json(UserSchema.parse(user));')] },
  { name: 'res aliased', edits: [getOne('const out = res;\n    out.json(user);')] },
  { name: 'res patched through defineProperty', edits: [getOne("Object.defineProperty(res, 'json', { value: res.send.bind(res) });\n    res.json(UserSchema.parse(user));")] },
  { name: 'response sent from eval', edits: [getOne("eval('res.json(user)');")] },
  { name: 'response sent from new Function', edits: [getOne("new Function('res', 'user', 'res.json(user)')(res, user);")] },

  // ── input the analysis does not model ──
  { name: 'unchecked safeParse', edits: [[USERS, 'const body = CreateUserBodySchema.parse(req.body);', 'const parsed = CreateUserBodySchema.safeParse(req.body);\n    const body = parsed.data as z.infer<typeof CreateUserBodySchema>;']] },
  { name: 'schema with .catch fallback', edits: [[USERS, "  role: UserRoleSchema.default('member'),\n});", "  role: UserRoleSchema.default('member'),\n}).catch({ email: 'a@b.co', name: 'anon', role: 'member' as const });"]] },
  { name: 'typed z.any() schema', edits: [[USERS, 'const CreateUserBodySchema = z.object({', 'const CreateUserBodySchema: z.ZodType<{ email: string; name: string; role: "admin" | "member" }> = z.any();\nconst UnusedSchema = z.object({']] },
  { name: 'raw query read', edits: [[USERS, 'const query = CursorQuerySchema.parse(req.query);', "const query = CursorQuerySchema.parse(req.query);\n    if (req.originalUrl.includes('debug')) void JSON.stringify(req.query['debug']);"]] },

  // ── chains and registrations the analysis does not model ──
  { name: 'declared-only middleware', edits: [[USERS, "router.get('/v1/users/:userId', (req, res)", "router.get('/v1/users/:userId', audit(), (req, res)"], [USERS, 'const UserListSchema', "declare function audit(): import('express').RequestHandler;\nconst UserListSchema"]] },
  { name: 'library handler', edits: [[USERS, "  return router;\n}", "  router.get('/v1/users-files', express.static('public'));\n  return router;\n}"], [USERS, "import { Router } from 'express';", "import express, { Router } from 'express';"]] },
  { name: 'router.all route', edits: [[USERS, "  return router;\n}", "  router.all('/v1/exports', (_req, res) => {\n    res.json([]);\n  });\n  return router;\n}"]] },
  { name: 'routes registered in a loop', edits: [[USERS, "  return router;\n}", "  for (const m of ['get', 'post'] as const) router[m]('/v1/mirrors', (_req, res) => { res.json([]); });\n  return router;\n}"]] },
  { name: 'a router nothing mounts', edits: [['src/routes/admin.ts', '', "import { Router } from 'express';\nimport { z } from 'zod';\nexport const adminRouter = Router();\nadminRouter.get('/v1/audits', (_req, res) => {\n  res.json(z.array(z.string()).parse([]));\n});\n"]] },
  { name: 'hand-written .js route file', edits: [['src/routes/legacy.js', '', "export function legacy(router) {\n  router.post('/v1/legacy', (req, res) => res.json(req.body));\n}\n"]] },
  { name: 'blanket authentication', edits: [[APP, '  registerRoutes(app);', "  app.use((_req, _res, next) => {\n    next(unauthorized());\n  });\n  registerRoutes(app);"], [APP, "import { registerRoutes } from './routes/index.ts';", "import { registerRoutes } from './routes/index.ts';\nimport { HttpProblem } from './lib/problem.ts';\nconst unauthorized = (): Error => new HttpProblem({ type: 'https://example.com/problems/unauthorized', title: 'Unauthorized', status: 401, detail: 'Credentials are required.' });"]] },

  // ── errors the analysis does not model ──
  { name: 'service throws a plain Error', edits: [[USERS, 'throw conflict(`email: User with email ${email} already exists.`);', "throw new Error('duplicate email');"]] },
  { name: 'handler rejects with a plain object', edits: [[USERS, 'if (!users.has(userId)) throw notFound(`User ${userId} was not found.`);', "if (!users.has(userId)) throw { status: 404, message: 'gone' };"]] },
];

async function mutate(i: number, m: Mutation): Promise<string> {
  const dir = join(TMP, String(i));
  await cp(BASE, dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
  for (const [file, find, replace] of m.edits) {
    const path = join(dir, file);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, replace, 'utf8');
      continue;
    }
    const at = text.indexOf(find);
    if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error(`${m.name}: "${find.slice(0, 60)}" must occur exactly once in ${file}`);
    await writeFile(path, text.slice(0, at) + replace + text.slice(at + find.length), 'utf8');
  }
  return dir;
}

async function verdict(dir: string): Promise<string> {
  const out = await run('node', [join(ROOT, 'bin', 'harness.mjs'), 'check', '--api', dir], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
  return out.stdout.split('\n').find((l) => l.startsWith('verdict')) ?? '(no verdict)';
}

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe('fail-closed mutation audit of governed/users-api', () => {
  it('the unmutated API reads 100%', async () => {
    expect(await verdict(await mutate(-1, { name: 'none', edits: [] }))).toMatch(/100%/);
  });

  it.concurrent.each(MUTATIONS.map((m, i) => [m.name, m, i] as const))('%s is not 100%%', async (_name, m, i) => {
    const v = await verdict(await mutate(i, m));
    expect(v, v).not.toMatch(/100%/);
    expect(v).toMatch(/UNPROVEN|FAIL|\d+%/);
  });
});
