/**
 * zod-boundary: every request input is parsed by a Zod schema at the boundary (in the
 * handler or anywhere in its middleware chain), every 2xx response body is produced by
 * `<schema>.parse(...)`, schemas actually constrain the data, and no DTO type is
 * hand-written (types are inferred from schemas).
 */
import { glob } from 'tinyglobby';
import ts from 'typescript';
import { activeLayout, defineCheck, isSourcePath } from '../../src/core/plugin-api.ts';
import type { CheckContext, CheckFinding, Violation } from '../../src/core/plugin-api.ts';
import { constString, dynamicRouteReason, extractRouteTable, hasPathParams, isZodSchemaType, location, permissiveReason, programFile, routeLabel, routeUnknownReason, schemaConstructReason, walk } from '../lib/api-ast.ts';
import type { ParseSite, RouteInfo, SchemaRef } from '../lib/api-ast.ts';
import { unprovenFinding } from '../lib/plugin-helpers.ts';

const RULE = 'zod-boundary';

const DOC = `zod-boundary (unit: route handlers; each hand-written DTO type is one more failing unit)
A route handler passes iff ALL of (its middleware chain counts: validate({ body: S }) and router.use(...) included):
1. Every read of req.params / req.query / req.body / req.headers / req.get() / req.header(), in the handler or a
   middleware, is the direct argument of <schema>.parse() / .safeParse() / .parseAsync() / .safeParseAsync(), or of
   a program helper whose every return is its parse of that parameter (validate(S, req.query): S.parse(v), or r.data
   of r = S.safeParse(v) only after r.success), or follows a middleware that wrote the parsed value back
   (req.body = S.parse(req.body)). Serialising a whole part with JSON.stringify is exempt; passing \`req\` is not.
2. A path with :param segments parses req.params; POST / PUT / PATCH parse req.body (anywhere in the chain).
3. Schemas constrain the data: z.any()/z.unknown()/z.custom() without a type, z.record(k, z.unknown()) and
   z.object({}).passthrough()/.loose() validate nothing and fail, as request or response schemas.
4. Every 2xx (or non-constant status) body sent with res.json(x) / res.send(x) is <schema>.parse(...) (or a const
   / helper returning one) or a full problem. res.status(204).end() is fine. Program helpers given \`res\`
   (respond(res, 201, body)) and middleware are judged like the handler (their sends, statuses included, are the
   route's); \`res\` given to code that cannot be followed (a library function) is UNPROVEN, aliasing it fails.
   A parsed const must not change between the parse and the send (member assignment, delete, ++, push/splice/…,
   Object.assign(it, …), through any alias): FAIL. Handing it to code that may change it (an unknown function,
   storing it in another structure) before the send: UNPROVEN. res.json(Schema.parse(value)) at the send is fine.
Per src file: no hand-written data types: interface, type X = { ... } (also arrays/tuples of them), DTO classes,
or an enum duplicating a z.enum; use type X = z.infer<typeof XSchema>. Method-only interfaces (ports) are fine.
A route whose path cannot be resolved statically and that does not parse req.params is UNPROVEN.
Passing example:
  usersRouter.post('/v1/users', idempotency(), (req, res) => {
    const body = CreateUserSchema.parse(req.body);
    const user = store.create(body);
    res.status(201).location(\`/v1/users/\${user.id}\`).json(UserSchema.parse(user));
  });
  usersRouter.get('/v1/users/:userId', validate({ params: UserParamsSchema }), (req, res) => {
    const user = store.get(req.params.userId);
    if (user === undefined) throw notFound(\`user \${req.params.userId} not found\`);
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

/** Violations of one route (the :param rule only when the path is known). */
export function handlerViolations(root: string, r: RouteInfo, checker: ts.TypeChecker, knownPath = true): Violation[] {
  const label = routeLabel(r);
  const out: Violation[] = [];
  if (r.handler === undefined) {
    out.push({ location: location(root, r.registration), message: `${label}: handler could not be resolved to a function; cannot verify its boundary` });
    return out;
  }
  const gap = (s: SchemaRef): string | undefined => permissiveReason(checker, s.parsedType) ?? schemaConstructReason(checker, s.expr);
  for (const read of r.unparsedReads) {
    const what = READ_TEXT[read.target] ?? `req.${read.target}`;
    const why = read.note !== undefined ? ` (${read.note})` : '';
    out.push({ location: location(root, read.node), message: `${label}: ${what} is read without <ZodSchema>.parse()${why}; parse it directly, e.g. XSchema.parse(${read.target === 'req' ? 'req.body' : read.target === 'headers' ? 'req.headers' : `req.${read.target}`})` });
  }
  const permissive = new Set<ParseSite>();
  for (const p of r.parses) {
    const why = gap(p.schema);
    if (why !== undefined) {
      permissive.add(p);
      out.push({ location: location(root, p.call), message: `${label}: ${p.schema.text} accepts anything (${why}), so req.${p.target} is not validated; use a concrete schema` });
    }
  }
  const parsed = new Set(r.parses.filter((p) => !permissive.has(p)).map((p) => p.target));
  if (knownPath && hasPathParams(r.path) && !parsed.has('params')) {
    out.push({ location: location(root, r.handler), message: `${label}: path parameters are not parsed; add const { … } = ParamsSchema.parse(req.params)` });
  }
  if ((r.method === 'post' || r.method === 'put' || r.method === 'patch') && !parsed.has('body')) {
    out.push({ location: location(root, r.handler), message: `${label}: request body is not parsed; add const body = BodySchema.parse(req.body)` });
  }
  for (const node of r.resEscapes) {
    out.push({ location: location(root, node), message: `${label}: \`res\` is passed along or aliased, so the response body cannot be verified; respond with res.json(Schema.parse(value)) in the handler` });
  }
  const judged = new Set<ts.Node>();
  for (const resp of [...r.responses, ...r.chainResponses]) {
    if (judged.has(resp.call)) continue;
    judged.add(resp.call);
    // A middleware or helper answering before the handler sends the route's response too.
    const who = resp.via !== undefined
      ? ` (sent by ${resp.via.expression.getText()}(), called at ${location(root, resp.via)})`
      : r.responses.includes(resp) ? '' : ' (sent by a middleware/helper in the route chain)';
    const why = resp.schema !== undefined ? gap(resp.schema) : undefined;
    if (resp.schema !== undefined && why !== undefined) {
      out.push({ location: location(root, resp.call), message: `${label}: response schema ${resp.schema.text} accepts anything (${why}); use the resource schema${who}` });
      continue;
    }
    if (!resp.hasBody || resp.schema !== undefined || resp.isProblem || resp.replay === true) continue;
    if (resp.statuses !== null && resp.statuses.every((s) => s < 200 || s > 299)) continue;
    if (resp.taint?.kind === 'escaped') continue; // UNPROVEN (handlerUnproven), unless something else fails
    if (resp.taint?.kind === 'mutated') {
      out.push({
        location: location(root, resp.call),
        message: `${label}: response body ${resp.taint.name} is changed after its Zod parse (at ${location(root, resp.taint.node)}), so what is sent is not the schema's output; parse at the send: res.json(Schema.parse(${resp.taint.name}))${who}`,
      });
      continue;
    }
    out.push({ location: location(root, resp.call), message: `${label}: response body is not parsed with a Zod schema; send ResponseSchema.parse(value)${who}` });
  }
  return out;
}

/** Why a route's 2xx body cannot be proven to be a schema's output although nothing is known to be wrong. */
export function handlerUnproven(root: string, r: RouteInfo): string[] {
  const out: string[] = [];
  for (const call of r.resUnfollowed) {
    out.push(
      `${location(root, call)}: ${routeLabel(r)}: \`res\` is passed to ${call.expression.getText()}(), which cannot be followed (not program code with a plain res parameter), so what it sends is unproven; respond with res.json(Schema.parse(value)) in the handler or a program helper`,
    );
  }
  for (const resp of [...r.responses, ...r.chainResponses]) {
    if (resp.taint?.kind !== 'escaped' || resp.isProblem || (resp.statuses !== null && resp.statuses.every((s) => s < 200 || s > 299))) continue;
    out.push(
      `${location(root, resp.call)}: ${routeLabel(r)}: the parsed response body ${resp.taint.name} is passed to code that may change it before the send (at ${location(root, resp.taint.node)}), so whether the body is still the schema's output is unproven; send res.json(Schema.parse(${resp.taint.name}))`,
    );
  }
  return [...new Set(out)];
}

// ───────────────────────────── hand-written types ─────────────────────────────

/** A member that is behaviour (method, call/construct signature, or a property holding a function). */
function isMethodMember(m: ts.TypeElement | ts.ClassElement): boolean {
  if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m) || ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m)) return true;
  if (ts.isGetAccessor(m) || ts.isSetAccessor(m) || ts.isConstructorDeclaration(m)) return true;
  if (ts.isPropertySignature(m)) return m.type !== undefined && (ts.isFunctionTypeNode(m.type) || ts.isConstructorTypeNode(m.type));
  if (ts.isPropertyDeclaration(m) && m.initializer !== undefined) {
    const init = m.initializer;
    return ts.isArrowFunction(init) || ts.isFunctionExpression(init);
  }
  return false;
}

/** Whether a type node declares a data shape: an object literal type with data members, directly or as an element/argument. */
function declaresData(node: ts.TypeNode): boolean {
  if (ts.isTypeLiteralNode(node)) return node.members.length > 0 && !node.members.every(isMethodMember);
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) return declaresData(node.type);
  if (ts.isArrayTypeNode(node)) return declaresData(node.elementType);
  if (ts.isTupleTypeNode(node)) return node.elements.some((el) => declaresData(ts.isNamedTupleMember(el) ? el.type : el));
  if (ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node)) return declaresData(node.type);
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) return node.types.some(declaresData);
  if (ts.isTypeReferenceNode(node)) return (node.typeArguments ?? []).some(declaresData);
  return false;
}

/** Inside `declare global { … }` / `declare module '…' { … }`: augmenting a library's types, not a DTO. */
function inAmbientModule(node: ts.Node): boolean {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isModuleDeclaration(p) && (p.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

/** A pure data holder class: no base class, at least one data property, and no behaviour. */
function isDtoClass(node: ts.ClassDeclaration): boolean {
  if ((node.heritageClauses ?? []).some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) return false;
  const ctor = node.members.find(ts.isConstructorDeclaration);
  const paramProps = (ctor?.parameters ?? []).filter((p) => (ts.getModifiers(p) ?? []).length > 0);
  const others = node.members.filter((m) => !ts.isConstructorDeclaration(m) && !(ts.isPropertyDeclaration(m) && (ts.getModifiers(m) ?? []).some((x) => x.kind === ts.SyntaxKind.StaticKeyword)));
  const data = others.filter((m) => ts.isPropertyDeclaration(m) && !isMethodMember(m));
  const behaviour = others.some((m) => isMethodMember(m));
  const ctorDoesWork = ctor?.body !== undefined && ctor.body.statements.length > 0;
  return !behaviour && !ctorDoesWork && data.length + paramProps.length > 0;
}

/** String value sets of every `z.enum([...])` in the program sources (TS enums duplicating one are hand-written). */
export function zodEnumValueSets(checker: ts.TypeChecker, files: ts.SourceFile[]): string[][] {
  const sets: string[][] = [];
  for (const sf of files) {
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'enum') return;
      const arg = n.arguments[0];
      if (arg === undefined || !ts.isArrayLiteralExpression(arg) || !isZodSchemaType(checker, checker.getTypeAtLocation(n))) return;
      const values = arg.elements.map((e) => constString(checker, e));
      if (values.every((v): v is string => v !== undefined)) sets.push(values);
    });
  }
  return sets;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((v) => sb.has(v));
}

export function handWrittenTypes(root: string, sf: ts.SourceFile, checker?: ts.TypeChecker, zodEnums: string[][] = []): Violation[] {
  const out: Violation[] = [];
  const flag = (name: ts.Identifier, kind: string, why: string): void => {
    out.push({ location: location(root, name), message: `${kind} ${name.text}: ${why}` });
  };
  const HAND = 'hand-written type: infer it from a Zod schema (z.infer)';
  walk(sf, (node) => {
    if (inAmbientModule(node)) return;
    if (ts.isInterfaceDeclaration(node)) {
      // Ports (repositories, services) declare behaviour only; data shapes come from schemas.
      const methodOnly = node.members.every(isMethodMember);
      if (!methodOnly) flag(node.name, 'interface', HAND);
      return;
    }
    if (ts.isTypeAliasDeclaration(node) && declaresData(node.type)) {
      flag(node.name, 'type', HAND);
      return;
    }
    if (ts.isClassDeclaration(node) && node.name !== undefined && isDtoClass(node)) {
      flag(node.name, 'class', 'hand-written DTO class: declare a Zod schema and use z.infer');
      return;
    }
    if (ts.isEnumDeclaration(node) && checker !== undefined) {
      const values = node.members.map((mem) => checker.getConstantValue(mem));
      if (values.every((v): v is string => typeof v === 'string') && zodEnums.some((s) => sameSet(s, values))) {
        flag(node.name, 'enum', 'duplicates a z.enum([...]); use z.infer<typeof Schema> (or derive the schema with z.enum(Enum))');
      }
    }
  });
  return out;
}

// ───────────────────────────── run ─────────────────────────────

function unresolvedRouteFinding(root: string, r: RouteInfo, file: string): CheckFinding {
  const why = r.unresolvedPath?.reason ?? 'path could not be resolved';
  const at = location(root, r.unresolvedPath?.node ?? r.registration);
  return unprovenFinding(RULE, file, `${at}: ${r.method.toUpperCase()} route: ${why}, so whether its path parameters are parsed is unproven (parse req.params or use a constant path)`);
}

/**
 * Source files the analysis does not read (JavaScript, JSX/TSX) under the API's source roots: a route or
 * input read in one is judged by no rule, so each makes the rule UNPROVEN (fail-closed).
 */
async function unanalysedSources(ctx: CheckContext): Promise<CheckFinding[]> {
  const files = await glob(['**/*.{js,mjs,cjs,jsx,tsx}'], { cwd: ctx.root, ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**'] });
  return files
    .map((f) => f.split('\\').join('/'))
    .filter((f) => isSourcePath(f.replace(/\.(m|c)?jsx?$|\.tsx$/, '.ts'), ctx.layout ?? activeLayout()))
    .sort()
    .map((f) => unprovenFinding(RULE, f, `${f} is under the source roots but is not TypeScript the analysis reads, so any route or input it handles is judged by no rule; write it as .ts`));
}

async function run(ctx: CheckContext): Promise<CheckFinding[]> {
  const program = ctx.program();
  const checker = program.getTypeChecker();
  const table = extractRouteTable(program, ctx.root, ctx.sourceFiles);
  const sources = ctx.sourceFiles.map((f) => programFile(program, ctx.root, f) ?? ctx.sourceFile(f));
  const zodEnums = zodEnumValueSets(checker, sources);
  const findings: CheckFinding[] = await unanalysedSources(ctx);
  for (const file of ctx.sourceFiles) {
    const sf = programFile(program, ctx.root, file) ?? ctx.sourceFile(file);
    const fileRoutes = table.all.filter((r) => r.file === file);
    for (const d of table.dynamic.filter((x) => x.file === file)) findings.push(unprovenFinding(RULE, file, dynamicRouteReason(ctx.root, d)));
    const types = handWrittenTypes(ctx.root, sf, checker, zodEnums);
    // Units are route handlers; each hand-written DTO type is one extra (failing) unit.
    // A file with neither has nothing to prove and produces no finding.
    if (fileRoutes.length === 0 && types.length === 0) continue;
    let passed = 0;
    let total = 0;
    const violations: Violation[] = [];
    for (const r of fileRoutes) {
      const known = r.unresolvedPath === undefined;
      const v = handlerViolations(ctx.root, r, checker, known);
      const unproven = handlerUnproven(ctx.root, r);
      const unknown = routeUnknownReason(ctx.root, r, 'input and response');
      if (unknown !== undefined) unproven.push(unknown);
      if (v.length === 0 && unproven.length > 0) {
        for (const why of unproven) findings.push(unprovenFinding(RULE, file, why));
        continue;
      }
      if (!known && v.length === 0 && !r.parses.some((p) => p.target === 'params')) {
        // Nothing wrong found, but a :param in the unknown path may go unparsed: unproven, never pass.
        findings.push(unresolvedRouteFinding(ctx.root, r, file));
        continue;
      }
      total++;
      if (v.length === 0) passed++;
      violations.push(...v);
    }
    violations.push(...types);
    total += types.length;
    if (total === 0) continue;
    findings.push({ rule: RULE, file, status: violations.length === 0 ? 'pass' : 'fail', units: { passed, total }, violations });
  }
  return findings;
}

export default defineCheck({
  id: RULE,
  category: 'standards',
  description: 'Every request input is parsed by a Zod schema (handler or middleware chain), every 2xx body is Schema.parse(...), schemas constrain data, and types are z.infer (no hand-written DTOs).',
  unit: 'handlers',
  doc: DOC,
  run,
});
