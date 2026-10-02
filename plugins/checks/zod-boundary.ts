/**
 * zod-boundary: every request input is parsed by a Zod schema at the boundary,
 * every 2xx response body is produced by `<schema>.parse(...)`, and no DTO type
 * is hand-written (types are inferred from schemas).
 */
import ts from 'typescript';
import { defineCheck } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';
import { extractRoutes, hasPathParams, location, programFile, routeLabel, walk } from '../lib/api-ast.ts';
import type { RouteInfo, SchemaRef } from '../lib/api-ast.ts';

const RULE = 'zod-boundary';

const DOC = `zod-boundary (unit: route handlers; each hand-written DTO type is one more failing unit)
A route handler passes iff ALL of:
1. Every read of req.params / req.query / req.body / req.headers / req.get() / req.header()
   is the direct argument of <schema>.parse() / .safeParse() / .parseAsync() / .safeParseAsync(),
   where <schema> is a Zod schema (z.any()/z.unknown() validate nothing and do not count).
   IdSchema.parse(req.params.userId) is fine; destructuring or passing \`req\` along is not.
2. A path with :param segments parses req.params.
3. POST / PUT / PATCH parse req.body.
4. Every 2xx (or unknown-status) body sent with res.json(x) / res.send(x) is <schema>.parse(...)
   or a const initialised with one. res.status(204).end() is fine; non-2xx bodies belong to problem-json.
   \`res\` is not passed to helpers (problem senders such as sendProblem(res, p) excepted).
Per src file: no \`interface\` declarations and no \`type X = { ... }\` object aliases;
use \`type X = z.infer<typeof XSchema>\`.
Passing example:
  usersRouter.post('/v1/users', idempotency(), (req, res) => {
    const body = CreateUserSchema.parse(req.body);
    const user = store.create(body);
    res.status(201).location(\`/v1/users/\${user.id}\`).json(UserSchema.parse(user));
  });
  usersRouter.get('/v1/users/:userId', (req, res) => {
    const { userId } = UserParamsSchema.parse(req.params);
    const user = store.get(userId);
    if (user === undefined) throw notFound(\`user \${userId} not found\`);
    res.json(UserSchema.parse(user));
  });
  export type User = z.infer<typeof UserSchema>;`;

const READ_TEXT: Record<string, string> = {
  params: 'req.params',
  query: 'req.query',
  body: 'req.body',
  headers: 'req.headers / req.get()',
  req: '`req` (destructured or passed along)',
};

/** z.any() / z.unknown() style schemas: parsing with them validates nothing. */
function acceptsAnything(schema: SchemaRef): boolean {
  const t = schema.parsedType;
  return t !== undefined && (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

export function handlerViolations(root: string, r: RouteInfo): Violation[] {
  const label = routeLabel(r);
  const out: Violation[] = [];
  if (r.handler === undefined) {
    out.push({ location: location(root, r.registration), message: `${label}: handler could not be resolved to a function; cannot verify its boundary` });
    return out;
  }
  for (const read of r.unparsedReads) {
    const what = READ_TEXT[read.target] ?? `req.${read.target}`;
    out.push({ location: location(root, read.node), message: `${label}: ${what} is read without <ZodSchema>.parse(); parse it directly, e.g. XSchema.parse(${read.target === 'req' ? 'req.body' : read.target === 'headers' ? 'req.headers' : `req.${read.target}`})` });
  }
  for (const p of r.parses) {
    if (acceptsAnything(p.schema)) {
      out.push({ location: location(root, p.call), message: `${label}: ${p.schema.text} accepts anything (its output is any/unknown), so req.${p.target} is not validated; use a concrete schema` });
    }
  }
  const parsed = new Set(r.parses.filter((p) => !acceptsAnything(p.schema)).map((p) => p.target));
  if (hasPathParams(r.path) && !parsed.has('params')) {
    out.push({ location: location(root, r.handler), message: `${label}: path parameters are not parsed; add const { … } = ParamsSchema.parse(req.params)` });
  }
  if ((r.method === 'post' || r.method === 'put' || r.method === 'patch') && !parsed.has('body')) {
    out.push({ location: location(root, r.handler), message: `${label}: request body is not parsed; add const body = BodySchema.parse(req.body)` });
  }
  for (const node of r.resEscapes) {
    out.push({ location: location(root, node), message: `${label}: \`res\` is passed along or aliased, so the response body cannot be verified; respond with res.json(Schema.parse(value)) in the handler` });
  }
  for (const resp of r.responses) {
    if (resp.schema !== undefined && acceptsAnything(resp.schema)) {
      out.push({ location: location(root, resp.call), message: `${label}: response schema ${resp.schema.text} accepts anything (any/unknown output); use the resource schema` });
      continue;
    }
    if (!resp.hasBody || resp.schema !== undefined) continue;
    if (resp.status !== null && (resp.status < 200 || resp.status > 299)) continue;
    out.push({ location: location(root, resp.call), message: `${label}: response body is not parsed with a Zod schema; send ResponseSchema.parse(value)` });
  }
  return out;
}

function isObjectAlias(node: ts.TypeNode): boolean {
  if (ts.isTypeLiteralNode(node)) return true;
  if (ts.isParenthesizedTypeNode(node)) return isObjectAlias(node.type);
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) return node.types.some(isObjectAlias);
  return false;
}

/** Inside `declare global { … }` / `declare module '…' { … }`: augmenting a library's types, not a DTO. */
function inAmbientModule(node: ts.Node): boolean {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isModuleDeclaration(p) && (p.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

export function handWrittenTypes(root: string, sf: ts.SourceFile): Violation[] {
  const out: Violation[] = [];
  walk(sf, (node) => {
    if ((ts.isInterfaceDeclaration(node) || (ts.isTypeAliasDeclaration(node) && isObjectAlias(node.type))) && !inAmbientModule(node)) {
      out.push({
        location: location(root, node.name),
        message: `${ts.isInterfaceDeclaration(node) ? 'interface' : 'type'} ${node.name.text}: hand-written type: infer it from a Zod schema (z.infer)`,
      });
    }
  });
  return out;
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const program = ctx.program();
  const routes = extractRoutes(program, ctx.root, ctx.sourceFiles);
  const findings: CheckFinding[] = [];
  for (const file of ctx.sourceFiles) {
    const sf = programFile(program, ctx.root, file) ?? ctx.sourceFile(file);
    const fileRoutes = routes.filter((r) => r.file === file);
    const types = handWrittenTypes(ctx.root, sf);
    // Units are route handlers; each hand-written DTO type is one extra (failing) unit.
    // A file with neither has nothing to prove and produces no finding.
    if (fileRoutes.length === 0 && types.length === 0) continue;
    let passed = 0;
    const violations: Violation[] = [];
    for (const r of fileRoutes) {
      const v = handlerViolations(ctx.root, r);
      if (v.length === 0) passed++;
      violations.push(...v);
    }
    violations.push(...types);
    const total = fileRoutes.length + types.length;
    findings.push({ rule: RULE, file, status: violations.length === 0 ? 'pass' : 'fail', units: { passed, total }, violations });
  }
  return findings;
}

export default defineCheck({
  id: RULE,
  category: 'standards',
  description: 'Every request input is parsed by a Zod schema, every 2xx body is Schema.parse(...), and types are z.infer (no hand-written DTOs).',
  unit: 'handlers',
  doc: DOC,
  run,
});
