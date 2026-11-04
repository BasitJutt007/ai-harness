#!/usr/bin/env node
// Metric: admin-only-sweep (the adversarially verified, hardened probe of the assignment-02 candidate review).
// Static AST read of a vp-business-backend checkout with the checkout's own `typescript`.
// No network, no database, no secrets, no writes. Prints JSON; `value` is the metric.
// Usage: node metrics/admin-only-sweep.mjs [clone (default: cwd)] [--pretty] [--print-baseline]
// Measure contract (src/core/measure.ts): the JSON line, then the value alone on the last line.
//
// What it closes compared with admin-only-sweep.mjs:
//  - @AdminOnly must resolve (through imports/re-exports) to src/common/decorators/admin-only.decorator.ts
//  - every controller in src is scanned, so a target route moved to another file is still found
//  - any handler, anywhere, that calls one of the ten sensitive service methods must be @AdminOnly
//    (a renamed or moved route that still calls CompanyService.remove etc. stays open)
//  - no new non-admin route may appear under /admins, /company or /notifications
//  - guard, decorator and JwtStrategy.validate are compared, comments stripped, with the
//    harness-test a999dc4c baseline; AppModule must register JwtAuthGuard then AdminGuard as
//    APP_GUARD (read from the AST, so a comment cannot satisfy it)
//  - sentinels: vendor routes stay reachable, and the out-of-scope QA route is left as is
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const clone = path.resolve(process.argv[2] || '.');
const req = createRequire(path.join(clone, 'package.json'));
const ts = req('typescript');
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

const REAL_ADMIN_ONLY = { file: 'src/common/decorators/admin-only.decorator.ts', name: 'AdminOnly' };
const REAL_PUBLIC = { file: 'src/common/decorators/public.decorator.ts', name: 'Public' };
const REAL_GUARD = { file: 'src/common/guards/admin.guard.ts', name: 'AdminGuard' };
const REAL_JWT_GUARD = { file: 'src/modules/auth/guards/jwt.guard.ts', name: 'JwtAuthGuard' };
const STRATEGY = 'src/modules/auth/strategies/jwt.strategy.ts';
const APP = 'src/app.module.ts';

// Baseline (harness-test a999dc4c), comment-free printed text, sha256 first 16 hex.
const BASELINE = {
  guardCanActivate: '9644b832ba6d909f',
  decoratorFile: '4ee82939ec59bf9a',
  strategyValidate: 'f446506d5ac3a90c',
};

const SENSITIVE = [
  ['src/modules/admin/admin.service.ts', 'AdminService', ['createAdmin', 'getAllAdmins', 'updateAdmin', 'deleteAdmin']],
  ['src/modules/company/company.service.ts', 'CompanyService', ['remove', 'findAll', 'getFeatureSettingsByProductId', 'updateFeatureSettingsByProductId']],
  ['src/modules/notifications/notifications.service.ts', 'NotificationsService', ['create', 'findAllByProductSlug']],
];
const TARGETS = [
  ['POST', '/admins', false], ['GET', '/admins', false], ['PATCH', '/admins/:id', false], ['DELETE', '/admins/:id', false],
  ['GET', '/company/feature-settings/:productId', false], ['PATCH', '/company/feature-settings/:productId', false],
  ['DELETE', '/company/:id', true], ['GET', '/company/get', true],
  ['POST', '/notifications', true], ['GET', '/notifications/by-slug/:slug', true],
];
// Routes under the three bases that are vendor-reachable today and stay that way.
const VENDOR_KEEP = [
  ['GET', '/company/by-user'], ['GET', '/company/feature-settings'], ['GET', '/company/search'],
  ['POST', '/company/create'], ['POST', '/company/add-member'], ['PATCH', '/company/:id'],
  ['GET', '/company/:id'], ['GET', '/company/:id/members-with-products'], ['GET', '/company/:id/products'],
  ['GET', '/company/:companyId/members'],
  ['GET', '/notifications/me'], ['GET', '/notifications/by-user/:userId'],
  ['PATCH', '/notifications/:id/read'], ['PATCH', '/notifications/mark-all-read'],
];
// Out of scope (not_included): must be left exactly as reachable as today.
const LEAVE_AS_IS = [['POST', '/admins/qa/purchase-premium-plan']];
const BASES = ['admins', 'company', 'notifications'];

const HTTP = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Options', 'Head']);
const norm = (p) => '/' + p.split('/').filter(Boolean).map((s) => (s.startsWith(':') ? ':param' : s)).join('/');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !e.name.endsWith('.d.ts')) out.push(path.relative(clone, p));
  }
  return out;
}
const cache = new Map();
function parse(rel) {
  if (!cache.has(rel)) {
    const abs = path.join(clone, rel);
    cache.set(rel, fs.existsSync(abs) && fs.statSync(abs).isFile()
      ? ts.createSourceFile(rel, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true) : null);
  }
  return cache.get(rel);
}
function resolveSpec(fromRel, spec) {
  let base = null;
  if (spec.startsWith('.')) base = path.join(path.dirname(fromRel), spec);
  else if (spec.startsWith('src/')) base = spec;
  else if (spec.startsWith('@common/')) base = 'src/common/' + spec.slice(8);
  else if (spec.startsWith('@modules/')) base = 'src/modules/' + spec.slice(9);
  else if (spec.startsWith('@config/')) base = 'src/config/' + spec.slice(8);
  else if (spec.startsWith('@/')) base = 'src/' + spec.slice(2);
  if (base === null) return { pkg: spec };
  base = path.normalize(base);
  for (const c of [base + '.ts', path.join(base, 'index.ts')]) if (parse(c)) return { file: c };
  return { file: base + '.ts', missing: true };
}
const hasExportMod = (n) => (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;
// Follow an exported name to the file that declares it.
function resolveExport(fileRel, name, depth = 0) {
  if (depth > 6) return null;
  const sf = parse(fileRel);
  if (!sf) return null;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && hasExportMod(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return { file: fileRel, name };
    }
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name && st.name.text === name && hasExportMod(st)) return { file: fileRel, name };
    if (ts.isExportDeclaration(st)) {
      const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          if (el.name.text !== name) continue;
          const orig = (el.propertyName || el.name).text;
          if (from) { const r = resolveSpec(fileRel, from); return r.file ? resolveExport(r.file, orig, depth + 1) : null; }
          const imp = importsOf(sf).get(orig);
          if (imp) return resolveBinding(fileRel, imp, depth + 1);
          return { file: fileRel, name: orig };
        }
      } else if (from && !st.exportClause) {
        const r = resolveSpec(fileRel, from);
        if (r.file) { const hit = resolveExport(r.file, name, depth + 1); if (hit) return hit; }
      }
    }
  }
  return null;
}
const importCache = new Map();
function importsOf(sf) {
  if (importCache.has(sf.fileName)) return importCache.get(sf.fileName);
  const m = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const from = st.moduleSpecifier.text;
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) m.set(el.name.text, { kind: 'named', imported: (el.propertyName || el.name).text, from });
    if (nb && ts.isNamespaceImport(nb)) m.set(nb.name.text, { kind: 'ns', from });
    if (st.importClause.name) m.set(st.importClause.name.text, { kind: 'default', from });
  }
  importCache.set(sf.fileName, m);
  return m;
}
function resolveBinding(fileRel, imp, depth = 0, member = null) {
  const r = resolveSpec(fileRel, imp.from);
  if (r.pkg) return { pkg: r.pkg, name: imp.kind === 'ns' ? member : imp.imported };
  if (!r.file || r.missing) return null;
  return resolveExport(r.file, imp.kind === 'ns' ? member : imp.imported, depth);
}
// What a decorator / type / identifier refers to: {file,name} | {pkg,name} | {local}
function refOf(sf, expr) {
  const imports = importsOf(sf);
  if (ts.isIdentifier(expr)) {
    const imp = imports.get(expr.text);
    if (!imp) return { local: expr.text, file: sf.fileName };
    if (imp.kind === 'named') return resolveBinding(sf.fileName, imp);
    return null;
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const imp = imports.get(expr.expression.text);
    if (imp && imp.kind === 'ns') return resolveBinding(sf.fileName, imp, 0, expr.name.text);
  }
  return null;
}
const same = (a, b) => !!a && !!b && a.file === b.file && a.name === b.name;
const fromPkg = (r, pkg, name) => !!r && r.pkg === pkg && r.name === name;
const decsOf = (n) => (ts.canHaveDecorators(n) ? ts.getDecorators(n) || [] : []);
function decRef(sf, d) {
  const e = d.expression;
  const callee = ts.isCallExpression(e) ? e.expression : e;
  return { ref: refOf(sf, callee), args: ts.isCallExpression(e) ? e.arguments : [], call: ts.isCallExpression(e) };
}
function strArgs(a) {
  if (!a) return [''];
  if (ts.isStringLiteralLike(a)) return [a.text];
  if (ts.isArrayLiteralExpression(a)) return a.elements.every(ts.isStringLiteralLike) ? a.elements.map((x) => x.text) : null;
  if (ts.isObjectLiteralExpression(a)) {
    const p = a.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText() === 'path');
    return p ? strArgs(p.initializer) : [''];
  }
  return null; // not statically known
}
const isAdminOnlyDec = (sf, d) => { const x = decRef(sf, d); return x.call && x.args.length === 0 && same(x.ref, REAL_ADMIN_ONLY); };
const isPublicDec = (sf, d) => { const x = decRef(sf, d); return same(x.ref, REAL_PUBLIC); };

// field name -> {file,name} of its declared class type
function fieldTypes(sf, cls) {
  const m = new Map();
  const add = (name, typeNode) => {
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return;
    const r = refOf(sf, typeNode.typeName);
    if (r) m.set(name, r.local ? { file: sf.fileName, name: r.local } : r);
  };
  for (const mem of cls.members) {
    if (ts.isConstructorDeclaration(mem)) for (const p of mem.parameters) { if (ts.isIdentifier(p.name)) add(p.name.text, p.type); }
    if (ts.isPropertyDeclaration(mem) && ts.isIdentifier(mem.name)) add(mem.name.text, mem.type);
  }
  return m;
}
function find(node, pred, acc = []) { if (pred(node)) acc.push(node); ts.forEachChild(node, (c) => { find(c, pred, acc); }); return acc; }

const files = walk(path.join(clone, 'src'));
const routes = [];
const dynamic = [];
for (const rel of files) {
  const sf = parse(rel);
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st)) continue;
    const cdecs = decsOf(st);
    const ctrl = cdecs.find((d) => fromPkg(decRef(sf, d).ref, '@nestjs/common', 'Controller'));
    if (!ctrl) continue;
    const clsName = st.name ? st.name.text : '(anonymous)';
    const bases = strArgs(decRef(sf, ctrl).args[0]);
    const clsAdmin = cdecs.some((d) => isAdminOnlyDec(sf, d));
    const clsPublic = cdecs.some((d) => isPublicDec(sf, d));
    const ftypes = fieldTypes(sf, st);
    for (const m of st.members) {
      if (!ts.isMethodDeclaration(m)) continue;
      const mdecs = decsOf(m);
      const httpDecs = mdecs.filter((d) => { const r = decRef(sf, d).ref; return !!r && r.pkg === '@nestjs/common' && HTTP.has(r.name); });
      if (!httpDecs.length) continue;
      const handler = m.name.getText();
      const calls = m.body ? find(m.body, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && ts.isPropertyAccessExpression(n.expression.expression) && n.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword) : [];
      const svc = calls.map((c) => ({ type: ftypes.get(c.expression.expression.name.text), method: c.expression.name.text })).filter((x) => x.type);
      for (const hd of httpDecs) {
        const subs = strArgs(decRef(sf, hd).args[0]);
        const verb = decRef(sf, hd).ref.name.toUpperCase();
        const at = `${rel}:${sf.getLineAndCharacterOfPosition(m.getStart()).line + 1}`;
        if (!bases || !subs) { dynamic.push({ at, cls: clsName, handler }); continue; }
        for (const b of bases) for (const s of subs) {
          routes.push({ rel, at, cls: clsName, handler, verb, path: norm(`${b}/${s}`), adminOnly: clsAdmin || mdecs.some((d) => isAdminOnlyDec(sf, d)), isPublic: clsPublic || mdecs.some((d) => isPublicDec(sf, d)), svc });
        }
      }
    }
  }
}

// ---- integrity (AST, comments ignored) ----
function methodText(rel, clsName, method) {
  const sf = parse(rel);
  if (!sf) return null;
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && st.name && st.name.text === clsName) {
      for (const m of st.members) if (ts.isMethodDeclaration(m) && m.name.getText() === method && m.body) return printer.printNode(ts.EmitHint.Unspecified, m, sf);
    }
  }
  return null;
}
function fileText(rel) { const sf = parse(rel); return sf ? printer.printFile(sf) : null; }
function appGuards() {
  const sf = parse(APP);
  if (!sf) return [];
  const out = [];
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st)) continue;
    for (const d of decsOf(st)) {
      const x = decRef(sf, d);
      if (!fromPkg(x.ref, '@nestjs/common', 'Module') || !x.args[0] || !ts.isObjectLiteralExpression(x.args[0])) continue;
      const prov = x.args[0].properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'providers');
      if (!prov || !ts.isArrayLiteralExpression(prov.initializer)) continue;
      for (const el of prov.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) continue;
        const get = (k) => { const p = el.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText() === k); return p ? p.initializer : null; };
        const provide = get('provide'); const useClass = get('useClass');
        if (provide && fromPkg(refOf(sf, provide), '@nestjs/core', 'APP_GUARD') && useClass) out.push(refOf(sf, useClass));
      }
    }
  }
  return out;
}
const current = {
  guardCanActivate: (() => { const t = methodText(REAL_GUARD.file, 'AdminGuard', 'canActivate'); return t ? sha(t) : null; })(),
  decoratorFile: (() => { const t = fileText(REAL_ADMIN_ONLY.file); return t ? sha(t) : null; })(),
  strategyValidate: (() => { const t = methodText(STRATEGY, 'JwtStrategy', 'validate'); return t ? sha(t) : null; })(),
};
if (process.argv.includes('--print-baseline')) { console.log(JSON.stringify(current)); process.exit(0); }
const reasons = [];
for (const k of Object.keys(BASELINE)) if (current[k] !== BASELINE[k]) reasons.push(`${k} changed (${current[k]} != ${BASELINE[k]})`);
const g = appGuards();
const iJwt = g.findIndex((r) => same(r, REAL_JWT_GUARD));
const iAdm = g.findIndex((r) => same(r, REAL_GUARD));
if (iAdm < 0) reasons.push('AdminGuard not registered as APP_GUARD in AppModule');
if (iJwt < 0 || (iAdm >= 0 && iJwt > iAdm)) reasons.push('JwtAuthGuard not registered before AdminGuard');
const integ = { ok: reasons.length === 0, reasons };

// ---- evaluate ----
const details = [];
const openKeys = new Set();
const mark = (key, d) => { details.push(d); if (d.status.startsWith('open')) openKeys.add(key); };
const match = (verb, p) => routes.filter((r) => r.verb === verb && r.path === norm(p));
for (const [verb, p, removable] of TARGETS) {
  const hits = match(verb, p);
  if (!hits.length) { mark(`target ${verb} ${p}`, { id: `${verb} ${p}`, status: removable ? 'closed:removed' : 'open:route-missing', at: null }); continue; }
  for (const r of hits) {
    const status = r.isPublic ? 'open:public' : r.adminOnly ? 'closed:admin-only' : 'open:any-token';
    mark(`handler ${r.rel}#${r.cls}.${r.handler}`, { id: `${verb} ${p}`, status, at: r.at, handler: `${r.cls}.${r.handler}` });
  }
}
for (const r of routes) {
  for (const [file, name, methods] of SENSITIVE) {
    for (const c of r.svc) {
      if (c.type.file !== file || c.type.name !== name || !methods.includes(c.method)) continue;
      const status = r.isPublic ? 'open:public' : r.adminOnly ? 'closed:admin-only' : 'open:sensitive-call-unguarded';
      mark(`handler ${r.rel}#${r.cls}.${r.handler}`, { id: `${r.verb} ${r.path} calls ${name}.${c.method}`, status, at: r.at, handler: `${r.cls}.${r.handler}` });
    }
  }
}
const known = new Set([...TARGETS, ...VENDOR_KEEP, ...LEAVE_AS_IS].map(([v, p]) => `${v} ${norm(p)}`));
for (const r of routes) {
  const seg = r.path.split('/')[1];
  if (!BASES.includes(seg) || r.adminOnly || known.has(`${r.verb} ${r.path}`)) continue;
  mark(`handler ${r.rel}#${r.cls}.${r.handler}`, { id: `${r.verb} ${r.path}`, status: r.isPublic ? 'open:new-public-route' : 'open:new-open-route', at: r.at, handler: `${r.cls}.${r.handler}` });
}
for (const [verb, p] of VENDOR_KEEP) {
  const hits = match(verb, p);
  const status = !hits.length ? 'open:route-missing' : hits.some((r) => r.adminOnly) ? 'open:admin-only-breaks-vendor-ui' : 'closed:vendor-reachable';
  mark(`sentinel ${verb} ${p}`, { id: `${verb} ${p} stays vendor-reachable`, status, at: hits[0] ? hits[0].at : null });
}
for (const [verb, p] of LEAVE_AS_IS) {
  const hits = match(verb, p);
  const status = !hits.length ? 'open:out-of-scope-route-removed' : hits.some((r) => r.adminOnly) ? 'open:out-of-scope-route-gated' : 'closed:unchanged';
  mark(`sentinel ${verb} ${p}`, { id: `${verb} ${p} left as is (not_included)`, status, at: hits[0] ? hits[0].at : null });
}
for (const d of dynamic) {
  if (/modules\/(admin|company|notifications)\//.test(d.at)) mark(`dynamic ${d.at}`, { id: `${d.cls}.${d.handler} has a non-literal route path`, status: 'open:unreadable-route', at: d.at });
}
if (!integ.ok) openKeys.add('integrity');
details.sort((a, b) => (a.status + a.id + (a.at || '')).localeCompare(b.status + b.id + (b.at || '')));
const out = { metric: 'admin_only_routes_open_to_vendor_tokens.hardened', value: openKeys.size, routesScanned: routes.length, integrity: integ, details };
console.log(JSON.stringify(out, null, process.argv.includes('--pretty') ? 1 : 0));
console.log(String(out.value));
