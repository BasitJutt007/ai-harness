/**
 * Check runner and report format.
 *
 * Checks are plugins; this module gives them a shared, cached view of the API
 * (file lists, parsed source files, one strict ts.Program) and renders their
 * findings into the fixed-width report. Honesty boundary: a check that throws
 * is a `skip` (UNPROVEN), and a standards rule with nothing to check is never
 * reported as compliant.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { glob } from 'tinyglobby';
import ts from 'typescript';
import { createTypecheck, registerTypecheck } from './typecheck.ts';
import type { Typecheck } from './typecheck.ts';
import type {
  CheckContext,
  CheckFinding,
  CheckPlugin,
  CheckReport,
  Exec,
  LogStore,
  RuleSummary,
  TaskKind,
} from './types.ts';

const STANDARDS = 'standards';
/** The finding file of a whole-project result. */
const PROJECT = '(project)';
/** Why a standards rule with nothing to check is unproven. */
const EMPTY_WHY = '0 units';
/** Minimum rule column width; widened to the longest rule id + 2 so long ids stay aligned. */
const RULE_MIN_W = 18;
const DEFAULT_UNIT = 'units';
const STATUS_W = 6;
const FILE_MIN_W = 33;
const COUNT_W = 10;
const COMPACT_MAX_VIOLATIONS = 25;
const SEPARATOR = '─'.repeat(60);
const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**'];

// ───────────────────────────── context ─────────────────────────────

/** Run-level facts a check may use; all absent for a stand-alone `harness check`. */
export interface CheckRunInfo {
  taskKind?: TaskKind;
  base?: { repoRoot: string; rootRel: string; sha: string };
}

export async function createCheckContext(opts: {
  root: string;
  exec: Exec;
  harnessRoot: string;
  logs: LogStore;
} & CheckRunInfo): Promise<CheckContext> {
  const { root } = opts;
  const sourceFiles = (await glob(['src/**/*.ts'], { cwd: root, ignore: [...IGNORE, '**/*.test.ts', '**/*.spec.ts', '**/*.d.ts'] }))
    .map(posixify)
    .sort();
  const testFiles = [...new Set(
    (await glob(['test/**/*.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts'], { cwd: root, ignore: [...IGNORE, '**/*.d.ts'] })).map(posixify),
  )].sort();
  const sfCache = new Map<string, ts.SourceFile>();
  let deps: Record<string, string> | undefined;
  const dependencies = (): Record<string, string> => {
    deps ??= readDependencies(root);
    return { ...deps };
  };
  // One type check per context (forced strict options over every TS file of the API, see typecheck.ts):
  // program() is its primary program, and tsc-strict diagnoses that same program through typecheckOf(ctx).
  let typecheck: Typecheck | undefined;
  const getTypecheck = (): Typecheck => (typecheck ??= createTypecheck(root, dependencies));
  const program = (): ts.Program => getTypecheck().primary();
  registerTypecheck(program, getTypecheck);
  return {
    root,
    sourceFiles,
    testFiles,
    exec: opts.exec,
    harnessRoot: opts.harnessRoot,
    logs: opts.logs,
    ...(opts.taskKind !== undefined ? { taskKind: opts.taskKind } : {}),
    ...(opts.base !== undefined ? { base: { ...opts.base } } : {}),
    dependencies,
    read: (rel: string) => readFile(join(root, rel), 'utf8'),
    sourceFile(rel: string): ts.SourceFile {
      const cached = sfCache.get(rel);
      if (cached !== undefined) return cached;
      const abs = join(root, rel);
      const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      sfCache.set(rel, sf);
      return sf;
    },
    program,
  };
}

/** Merged dependencies + devDependencies of <root>/package.json; {} when absent or unreadable. */
export function readDependencies(root: string): Record<string, string> {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return {};
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  if (typeof pkg !== 'object' || pkg === null) return out;
  for (const key of ['dependencies', 'devDependencies']) {
    const section: unknown = (pkg as Record<string, unknown>)[key];
    if (typeof section !== 'object' || section === null || Array.isArray(section)) continue;
    for (const [name, version] of Object.entries(section)) {
      if (typeof version === 'string') out[name] = version;
    }
  }
  return out;
}

/**
 * The options the API is type-checked with: its (primary) tsconfig with every strict-family flag,
 * noUncheckedIndexedAccess and noEmit forced, or the harness's default when it has no tsconfig.json.
 */
export function compilerOptions(root: string): ts.CompilerOptions {
  return createTypecheck(root).options();
}

// ───────────────────────────── runner ─────────────────────────────

export async function runChecks(opts: {
  root: string;
  checks: CheckPlugin[];
  exec: Exec;
  harnessRoot: string;
  logs: LogStore;
  categories?: string[];
  rules?: string[];
} & CheckRunInfo): Promise<CheckReport> {
  const selected = selectChecks(opts.checks, opts.categories, opts.rules);
  const ctx = await createCheckContext(opts);
  const findings: CheckFinding[] = [];
  for (const check of selected) {
    try {
      findings.push(...(await check.run(ctx)));
    } catch (e) {
      findings.push({
        rule: check.id,
        file: '(project)',
        status: 'skip',
        units: { passed: 0, total: 0 },
        violations: [],
        skipReason: `check crashed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return { root: opts.root, findings, ...formatReport(findings, selected, opts.root) };
}

export function selectChecks(checks: CheckPlugin[], categories?: string[], rules?: string[]): CheckPlugin[] {
  return checks.filter((c) =>
    (categories === undefined || categories.length === 0 || categories.includes(c.category))
    && (rules === undefined || rules.length === 0 || rules.includes(c.id)));
}

// ───────────────────────────── report ─────────────────────────────

interface RuleView {
  summary: RuleSummary;
  findings: CheckFinding[];
  /** violations across findings (printed for unit === 'errors'). */
  violations: number;
  /** why the rule is unproven, if it is. */
  unprovenWhy?: string;
}

export function formatReport(
  findings: CheckFinding[],
  checks: CheckPlugin[],
  root: string,
): Pick<CheckReport, 'rules' | 'verdict' | 'text' | 'compact'> {
  const views = ruleViews(findings.map((f) => relativizeFinding(f, root)), checks);
  const fileW = Math.max(FILE_MIN_W, ...views.flatMap((v) => v.findings.map((f) => f.file.length + 2)));
  const ruleW = ruleWidth(views.map((v) => v.summary.rule));

  const full: string[] = [];
  const compact: string[] = [];
  let compactViolations = 0;
  let compactHidden = 0;
  for (const v of views) {
    const { rule, unit } = v.summary;
    // Nothing to check: a non-standards rule is n/a; a standards rule is unproven (an empty check proves nothing).
    const empty = v.summary.status === 'n/a' ? 'n/a' : v.unprovenWhy === EMPTY_WHY ? 'unproven' : null;
    if (v.findings.length === 0) {
      const line = `${pad(rule, ruleW)}${pad(empty ?? 'n/a', STATUS_W)}${pad('(none)', fileW)}0/0 ${unit}`;
      full.push(line);
      if (empty === 'unproven') compact.push(line);
      continue;
    }
    for (const f of v.findings) {
      // A skipped finding is what makes the rule UNPROVEN: say so, with its reason.
      const status = f.status === 'fail' ? 'FAIL' : f.status === 'skip' ? 'UNPROVEN' : (empty ?? 'pass');
      // The failing whole-project row of an `errors` rule counts the whole project, not only its own diagnostics.
      const errors = f.file === PROJECT && f.status === 'fail' ? v.violations : f.violations.length;
      const count = f.status === 'skip'
        ? `skipped: ${oneLine(f.skipReason ?? 'no reason given')}`
        : unit === 'errors' ? `${errors} errors` : `${f.units.passed}/${f.units.total} ${unit}`;
      const line = `${pad(rule, ruleW)}${pad(status, STATUS_W)}${pad(f.file, fileW)}${count}`;
      const vlines = f.violations.map((x) => `    ${x.location}  ${oneLine(x.message)}`);
      full.push(line, ...vlines);
      if (status === 'pass' || status === 'n/a') continue;
      compact.push(line);
      for (const vl of vlines) {
        if (compactViolations < COMPACT_MAX_VIOLATIONS) {
          compact.push(vl);
          compactViolations++;
        } else {
          compactHidden++;
        }
      }
    }
  }
  if (compactHidden > 0) compact.push(`    … ${compactHidden} more violations (see full report)`);

  const verdict = computeVerdict(views);
  const summary = [SEPARATOR, ...views.map((v) => summaryLine(v, ruleW)), `${pad('verdict', ruleW)}${verdict.label.padEnd(7)} → ${verdict.message}`];
  return {
    rules: views.map((v) => v.summary),
    verdict: { status: verdict.status, percent: verdict.percent },
    text: [...full, ...summary].join('\n'),
    compact: [...compact, ...summary].join('\n'),
  };
}

function ruleViews(findings: CheckFinding[], checks: CheckPlugin[]): RuleView[] {
  const meta = new Map<string, { category: string; unit: string }>();
  for (const c of checks) if (!meta.has(c.id)) meta.set(c.id, { category: c.category, unit: c.unit ?? DEFAULT_UNIT });
  for (const f of findings) if (!meta.has(f.rule)) meta.set(f.rule, { category: 'unknown', unit: DEFAULT_UNIT });

  const views: RuleView[] = [];
  for (const [rule, { category, unit }] of meta) {
    const fs = findings.filter((f) => f.rule === rule);
    const passed = sum(fs.map((f) => f.units.passed));
    const total = sum(fs.map((f) => f.units.total));
    const violations = sum(fs.map((f) => f.violations.length));
    const skipped = fs.find((f) => f.status === 'skip');
    // For an `errors`-unit rule (tsc-strict) "nothing to check" means it reported nothing at all.
    const empty = unit === 'errors' ? fs.length === 0 : total === 0;
    const failing = fs.some((f) => f.status === 'fail') || passed < total;
    let status: RuleSummary['status'];
    let unprovenWhy: string | undefined;
    if (skipped !== undefined) {
      status = 'unproven';
      unprovenWhy = 'skipped';
    } else if (failing) {
      status = 'fail';
    } else if (empty && category === STANDARDS) {
      status = 'unproven';
      unprovenWhy = EMPTY_WHY;
    } else if (empty) {
      // Nothing to check (e.g. an ORM rule on an API without an ORM): not applicable, never proven.
      status = 'n/a';
    } else {
      status = 'pass';
    }
    const summary: RuleSummary = { rule, category, unit, status, passed, total, files: new Set(fs.map((f) => f.file)).size };
    views.push(unprovenWhy === undefined ? { summary, findings: fs, violations } : { summary, findings: fs, violations, unprovenWhy });
  }
  return views;
}

/** Rule column width: max(18, longest rule id + 2). */
export function ruleWidth(rules: string[]): number {
  return Math.max(RULE_MIN_W, ...rules.map((r) => r.length + 2));
}

function summaryLine(v: RuleView, ruleW: number): string {
  const { rule, unit, status, passed, total } = v.summary;
  const label = status === 'fail' ? 'FAIL' : status;
  const num = String(unit === 'errors' ? v.violations : passed);
  const rest = unit === 'errors' ? ` ${unit}` : `/${total} ${unit}`;
  const gap = Math.max(1, COUNT_W - label.length - num.length);
  return `${pad(rule, ruleW)}${label}${' '.repeat(gap)}${num}${rest}`;
}

function computeVerdict(views: RuleView[]): { status: CheckReport['verdict']['status']; percent: number; label: string; message: string } {
  const counted = views.filter((v) => v.summary.status !== 'n/a');
  const passed = sum(counted.map((v) => v.summary.passed));
  const total = sum(counted.map((v) => v.summary.total));
  const percent = total === 0 ? 0 : Math.floor((passed * 100) / total);
  const unproven = counted.filter((v) => v.summary.status === 'unproven');
  const failing = counted.filter((v) => v.summary.status === 'fail');
  if (counted.length === 0) {
    return { status: 'unproven', percent: 0, label: 'UNPROVEN', message: 'nothing was checked' };
  }
  if (unproven.length > 0) {
    const parts = [`not proven: ${unproven.map((v) => `${v.summary.rule} (${v.unprovenWhy ?? 'unproven'})`).join(', ')}`];
    if (failing.length > 0) parts.push(`failing: ${failing.map((v) => v.summary.rule).join(', ')}`);
    return { status: 'unproven', percent, label: 'UNPROVEN', message: parts.join('; ') };
  }
  if (failing.length > 0) {
    return { status: 'fail', percent, label: `${percent}%`, message: `failing: ${failing.map((v) => v.summary.rule).join(', ')}` };
  }
  return { status: 'pass', percent: 100, label: '100%', message: 'all rules green' };
}

// ───────────────────────────── helpers ─────────────────────────────

function relativizeFinding(f: CheckFinding, root: string): CheckFinding {
  const fix = (p: string): string => {
    if (!p.startsWith(root)) return p;
    const rel = relative(root, p).split(sep).join('/');
    return rel === '' ? p : rel;
  };
  return { ...f, file: fix(f.file), violations: f.violations.map((v) => ({ ...v, location: fix(v.location) })) };
}

function pad(s: string, w: number): string {
  return s.length >= w ? `${s}  ` : s.padEnd(w);
}

function oneLine(s: string): string {
  const line = s.split('\n').map((l) => l.trim()).filter((l) => l !== '').join(' ');
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function posixify(p: string): string {
  return p.split(sep).join('/');
}
