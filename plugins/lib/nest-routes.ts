/**
 * NestJS routes from source, by the decorators (no app is started): every method of a @Controller
 * class that carries an HTTP-method decorator (@Get, @Post, @Put, @Patch, @Delete, @All, @Options,
 * @Head) is a route, with the controller's path joined to the method's. Used by nest-route-guard
 * (who may call it) and route-lock (did a change remove or move one).
 *
 * Fail closed: a path the extractor cannot read as a string literal (a variable, a template, an
 * options object it does not model) makes the route `unknown`, never silently a path; callers treat
 * an unknown route as unproven.
 */
import ts from 'typescript';

export const HTTP_DECORATORS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Options', 'Head'] as const;

export interface NestRoute {
  /** HTTP method in upper case (ALL for @All). */
  method: string;
  /** Joined path, e.g. /admin/reports/:id ('' parts dropped, always one leading slash). */
  path: string;
  /** Class.method */
  handler: string;
  /** API-relative file and 1-based line of the method. */
  file: string;
  line: number;
  /** Decorator names on the method and on its class (e.g. UseGuards, Roles, or a codebase's own). */
  methodDecorators: string[];
  classDecorators: string[];
  /** Why the path could not be read exactly (the route is then not comparable). */
  unknown?: string;
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function decoratorName(d: ts.Decorator): string | null {
  const e = d.expression;
  if (ts.isCallExpression(e)) {
    const c = e.expression;
    if (ts.isIdentifier(c)) return c.text;
    if (ts.isPropertyAccessExpression(c)) return c.name.text;
    return null;
  }
  if (ts.isIdentifier(e)) return e.text;
  return null;
}

/** The literal path argument(s) of a decorator call: [] = no argument (''), null = not a literal it models. */
function pathArgs(d: ts.Decorator): string[] | null {
  const e = d.expression;
  if (!ts.isCallExpression(e)) return [''];
  const a = e.arguments[0];
  if (a === undefined) return [''];
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return [a.text];
  if (ts.isArrayLiteralExpression(a) && a.elements.every((x) => ts.isStringLiteral(x))) return a.elements.map((x) => (x as ts.StringLiteral).text);
  if (ts.isObjectLiteralExpression(a)) {
    const p = a.properties.find((x) => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === 'path');
    if (p === undefined) return [''];
    if (ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer))) return [p.initializer.text];
    return null;
  }
  return null;
}

export function joinPath(...parts: string[]): string {
  const segs = parts.flatMap((p) => p.split('/')).map((s) => s.trim()).filter((s) => s.length > 0);
  return `/${segs.join('/')}`;
}

/** Every route a source file declares (empty when it has no controller). */
export function routesOf(file: string, text: string): NestRoute[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: NestRoute[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      const classDecos = decoratorsOf(node);
      const controller = classDecos.find((d) => decoratorName(d) === 'Controller');
      if (controller !== undefined) {
        const className = node.name?.text ?? '(anonymous)';
        const prefixes = pathArgs(controller);
        const classNames = classDecos.map(decoratorName).filter((n): n is string => n !== null);
        for (const m of node.members) {
          if (!ts.isMethodDeclaration(m)) continue;
          const decos = decoratorsOf(m);
          const names = decos.map(decoratorName).filter((n): n is string => n !== null);
          const http = decos.filter((d) => (HTTP_DECORATORS as readonly string[]).includes(decoratorName(d) ?? ''));
          const handler = `${className}.${m.name.getText(sf)}`;
          const line = sf.getLineAndCharacterOfPosition(m.getStart(sf)).line + 1;
          for (const h of http) {
            const method = (decoratorName(h) ?? '').toUpperCase();
            const paths = pathArgs(h);
            if (prefixes === null || paths === null) {
              out.push({ method, path: '(unknown)', handler, file, line, methodDecorators: names, classDecorators: classNames, unknown: `${prefixes === null ? '@Controller' : `@${decoratorName(h) ?? ''}`} path is not a string literal` });
              continue;
            }
            for (const pre of prefixes) for (const p of paths) out.push({ method, path: joinPath(pre, p), handler, file, line, methodDecorators: names, classDecorators: classNames });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** "GET /admin/reports/:id" with parameter names normalised (renaming :id to :reportId is not a change). */
export function routeKey(r: Pick<NestRoute, 'method' | 'path'>): string {
  return `${r.method} ${r.path.replace(/:[A-Za-z0-9_]+/g, ':param')}`;
}

/**
 * The first of `names` the route carries, on its method or on its controller class; null when it carries
 * none. Which names mean "admin only" or "public" differs per codebase, so callers pass them in (the
 * nest-route-guard check reads them from harness.config.json) instead of this module assuming one set.
 */
export function decoratorOf(r: NestRoute, names: readonly string[]): string | null {
  return names.find((n) => r.methodDecorators.includes(n) || r.classDecorators.includes(n)) ?? null;
}

/** Admin-facing: an `admin` path segment, or a file under an admin/ directory. */
export function isAdminFacing(r: NestRoute): boolean {
  return r.path.split('/').some((s) => s.toLowerCase() === 'admin') || /(^|\/)admin\//.test(r.file);
}
