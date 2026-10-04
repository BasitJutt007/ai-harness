/**
 * What a target API can import besides its own files: the packages its package.json declares, which
 * of them resolve from the API root (the node_modules chain Node would walk), and the module
 * specifiers that are really the API's own modules through tsconfig `paths` / `baseUrl`. Shared by
 * the dependency-policy hook and the orphans gate.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { importSpecifiers } from '../../src/core/plugin-api.ts';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** What the API can import besides its own files, from its package.json, node_modules chain and tsconfig. */
export interface DependencyView {
  /** Declared package names (every dependency field), sorted. */
  declared: string[];
  /** The API's own package name (self-reference), if any. */
  self: string | null;
  /** Whether `pkg` resolves from the API root (some node_modules/<pkg> in the root or an ancestor). */
  resolves(pkg: string): boolean;
  /** Whether `spec` names a module of the API itself through tsconfig `paths` or `baseUrl`. */
  localAlias(spec: string): boolean;
}

/** The package a bare specifier names: `@scope/name` or the first path segment. */
export function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
}

/** A specifier that names a package or builtin (not a relative or absolute path, not a package-internal `#import`). */
export function isBare(spec: string): boolean {
  return spec !== '' && !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('#') && !/^[A-Za-z]:[\\/]/.test(spec);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** tsconfig `paths` patterns and `baseUrl` (with `extends` applied), or none when there is no usable tsconfig.json. */
function aliasConfig(root: string): { patterns: string[]; baseUrl: string | null } {
  const configPath = path.join(root, 'tsconfig.json');
  if (!existsSync(configPath)) return { patterns: [], baseUrl: null };
  const read = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
  if (read.error !== undefined) return { patterns: [], baseUrl: null };
  // Options only (extends applied): no directory walk for the include globs.
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: (f) => ts.sys.fileExists(f),
    readFile: (f) => ts.sys.readFile(f),
  };
  const { options } = ts.parseJsonConfigFileContent(read.config, host, root, undefined, configPath);
  return { patterns: Object.keys(options.paths ?? {}), baseUrl: options.baseUrl ?? null };
}

/** `spec` matches a tsconfig paths pattern (`@/*`, `~lib/*`, an exact key). */
function matchesPattern(spec: string, pattern: string): boolean {
  const star = pattern.indexOf('*');
  if (star === -1) return spec === pattern;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return spec.length >= prefix.length + suffix.length && spec.startsWith(prefix) && spec.endsWith(suffix);
}

const MODULE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'];

/** The dependency view of the API at `root` (absolute). */
export function dependencyView(root: string): DependencyView {
  const pkg = readJson(path.join(root, 'package.json'));
  const declared = new Set<string>();
  if (isRecord(pkg)) {
    for (const field of DEP_FIELDS) {
      const deps = pkg[field];
      if (isRecord(deps)) for (const name of Object.keys(deps)) declared.add(name);
    }
  }
  const self = isRecord(pkg) && typeof pkg['name'] === 'string' ? pkg['name'] : null;
  const dirs: string[] = [];
  for (let d = path.resolve(root); ; d = path.dirname(d)) {
    dirs.push(d);
    if (path.dirname(d) === d) break;
  }
  const alias = aliasConfig(root);
  return {
    declared: [...declared].sort(),
    self,
    resolves: (name) => dirs.some((d) => existsSync(path.join(d, 'node_modules', name, 'package.json'))),
    localAlias: (spec) => {
      if (alias.patterns.some((p) => matchesPattern(spec, p))) return true;
      if (alias.baseUrl === null) return false;
      // baseUrl-relative (`src/lib/x`): a module of the API, not a package.
      const abs = path.resolve(alias.baseUrl, spec.replace(/\.[cm]?js$/, ''));
      const inside = path.relative(root, abs);
      return !inside.startsWith('..') && !path.isAbsolute(inside) && MODULE_EXTS.some((ext) => existsSync(abs + ext));
    },
  };
}

/** Literal `require('x')` / `require.resolve('x')` specifiers (importSpecifiers covers the ESM forms). */
function requireSpecifiers(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const named = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? `${callee.expression.text}.${callee.name.text}` : '';
      const arg = n.arguments[0];
      if ((named === 'require' || named === 'require.resolve') && arg !== undefined && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every module specifier of a TypeScript file. */
export function moduleSpecifiers(rel: string, text: string): string[] {
  return [...importSpecifiers(rel, text), ...requireSpecifiers(rel, text)];
}
