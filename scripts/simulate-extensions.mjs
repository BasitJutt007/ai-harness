#!/usr/bin/env node
/**
 * Extensibility simulation: does what the grader does, in a throwaway copy of this repo.
 *
 *   node scripts/simulate-extensions.mjs [--no-run] [--keep]
 *
 * 1. Copies the repository's sources (tracked + untracked, minus ignored files, runs/ and
 *    tokens/) into .harness/tmp/<unique>/repo, `git init`s and commits it, and symlinks
 *    node_modules. The real repository is never touched (no branches, worktrees or commits).
 *    An example already copied into this repo's plugins/ is left out of the base, so it is
 *    still added fresh; children run without HARNESS_RUNS_DIR / HARNESS_TOKENS_DIR, so the
 *    scripted run's evidence stays inside the sandbox.
 * 2. Performs three extensions one at a time, each by copying ONE example file into plugins/:
 *      (a) tool    examples/plugins/tools/openapi_diff.ts         → plugins/tools/
 *      (b) check   examples/plugins/checks/orm-explicit-columns.ts → plugins/checks/  (category orm)
 *      (c) check   examples/plugins/checks/no-console.ts          → plugins/checks/  (category lint)
 * 3. After each: `harness plugins` must list it; checks must print their own line in
 *    `harness check --api samples/existing-api` (pass/FAIL with locations, or n/a when the
 *    API has nothing to check) and FAIL with file:line:col on test/fixtures/orm; the tool
 *    must be offered and called in a real (scripted, offline) run (skip with --no-run).
 *    Then `git diff --stat` + `git status --porcelain` are printed and every changed path
 *    must be under plugins/ — nothing under src/core/ (also proven by sha256 of src/core/**).
 * 4. Cleans up (worktree remove + branch delete in the temp repo, rm -rf), unless --keep.
 * Exit code 0 iff every assertion held.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const KEEP = flags.has('--keep');
const WITH_RUN = !flags.has('--no-run');
const API = 'samples/existing-api';
const FIXTURE = 'test/fixtures/orm';
const SKIP_PREFIXES = ['runs/', 'tokens/', 'node_modules/', '.harness/', '.git/'];
/**
 * The sandbox's evidence stays inside the sandbox: a parent HARNESS_RUNS_DIR / HARNESS_TOKENS_DIR
 * would send the child runs' runs/ and tokens/ elsewhere (and the checks below read them from
 * <sandbox>/runs), so every child gets an env without them.
 */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'HARNESS_RUNS_DIR' && k !== 'HARNESS_TOKENS_DIR'));
const GIT_ENV = { ...CHILD_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

const STEPS = [
  {
    title: '(a) new tool: openapi_diff',
    src: 'examples/plugins/tools/openapi_diff.ts',
    dest: 'plugins/tools/openapi_diff.ts',
    kind: 'tool',
    name: 'openapi_diff',
  },
  {
    title: '(b) custom ORM validator: orm-explicit-columns (category orm)',
    src: 'examples/plugins/checks/orm-explicit-columns.ts',
    dest: 'plugins/checks/orm-explicit-columns.ts',
    kind: 'check',
    name: 'orm-explicit-columns',
    onApi: ['n/a'], // samples/existing-api has no ORM: the rule reports n/a, never a vacuous pass
  },
  {
    title: '(c) new linter rule: no-console (category lint)',
    src: 'examples/plugins/checks/no-console.ts',
    dest: 'plugins/checks/no-console.ts',
    kind: 'check',
    name: 'no-console',
    onApi: ['pass'],
  },
];

const failures = [];
let tmp = '';
let repo = '';

// ───────────────────────────── output + assertions ─────────────────────────────

function say(s = '') {
  process.stdout.write(`${s}\n`);
}

function indent(text, n = 4) {
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => `${' '.repeat(n)}${l}`).join('\n');
}

function check(ok, what) {
  say(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
  return ok;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? repo, env: opts.env ?? GIT_ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 600_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
}

function git(...args) {
  const r = sh('git', ['-c', 'user.name=sim', '-c', 'user.email=sim@localhost', '-c', 'commit.gpgsign=false', ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.out.trim()}`);
  return r.stdout;
}

function harness(...args) {
  return sh(process.execPath, ['bin/harness.mjs', ...args], { env: CHILD_ENV });
}

// ───────────────────────────── sandbox ─────────────────────────────

/**
 * Files copied into the sandbox's base commit. The STEPS' destinations are left out even when
 * they exist here (someone already copied an example into plugins/), so each step still adds
 * its file fresh to a harness that does not have it yet.
 */
function sourceFiles() {
  const r = sh('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT });
  if (r.code !== 0) throw new Error(`git ls-files failed in ${ROOT}: ${r.out.trim()}`);
  const dests = new Set(STEPS.map((s) => s.dest));
  return [...new Set(r.stdout.split('\0'))]
    .filter((f) => f !== '' && !SKIP_PREFIXES.some((p) => f.startsWith(p)) && !dests.has(f))
    .filter((f) => existsSync(join(ROOT, f)) && lstatSync(join(ROOT, f)).isFile())
    .sort();
}

function makeSandbox() {
  tmp = join(ROOT, '.harness', 'tmp', `simulate-extensions-${process.pid}-${randomBytes(4).toString('hex')}`);
  repo = join(tmp, 'repo');
  const files = sourceFiles();
  for (const f of files) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(repo, f));
  }
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
  git('init', '-q', '-b', 'main');
  // The node_modules symlink is local plumbing, not a change: exclude it locally (untracked config).
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base: harness before any extension');
  return files.length;
}

function cleanup() {
  if (repo === '' || !existsSync(join(repo, '.git'))) {
    if (tmp !== '' && !KEEP) rmSync(tmp, { recursive: true, force: true });
    return;
  }
  // Remove any run worktrees and their branches inside the TEMP repo, then the temp dir.
  const list = sh('git', ['worktree', 'list', '--porcelain']).stdout;
  for (const line of list.split('\n')) {
    const p = line.startsWith('worktree ') ? line.slice('worktree '.length) : '';
    if (p !== '' && resolve(p) !== resolve(repo)) sh('git', ['worktree', 'remove', '--force', p]);
  }
  const branches = sh('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/harness/']).stdout;
  for (const b of branches.split('\n').filter((x) => x !== '')) sh('git', ['branch', '-D', b]);
  if (KEEP) say(`kept sandbox: ${repo}`);
  else rmSync(tmp, { recursive: true, force: true });
}

function coreHash() {
  const h = createHash('sha256');
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) h.update(`${abs.slice(repo.length)}\0`).update(readFileSync(abs));
    }
  };
  walk(join(repo, 'src', 'core'));
  return h.digest('hex');
}

// ───────────────────────────── per-step checks ─────────────────────────────

function ruleLines(text, rule) {
  return text.split('\n').filter((l) => l.startsWith(`${rule} `) || l.startsWith(`${rule}\t`));
}

function assertPlugins(step) {
  const r = harness('plugins');
  check(r.code === 0, `harness plugins exits 0 (no load errors)${r.code === 0 ? '' : `\n${indent(r.out)}`}`);
  const line = r.out.split('\n').find((l) => l.trim().startsWith(`${step.name} `) && l.includes(step.dest));
  check(line !== undefined, `harness plugins lists ${step.kind} "${step.name}" from ${step.dest}`);
  if (line !== undefined) say(indent(line.trim(), 8));
}

function assertCheckOnApi(step) {
  const r = harness('check', '--api', API);
  const lines = ruleLines(r.out, step.name);
  const perFile = lines.filter((l) => /^\S+\s+(pass|FAIL|skip|n\/a)\s+\S/.test(l) && !/^\S+\s+(pass|FAIL|n\/a|unproven)\s+\d+(\/\d+)?\s/.test(l));
  const summary = lines.find((l) => /^\S+\s+(pass|FAIL|n\/a|unproven)\s+\d+(\/\d+)?\s+\S/.test(l));
  say(`    harness check --api ${API} → exit ${String(r.code)}; ${step.name} lines:`);
  say(indent(lines.join('\n'), 8));
  check(perFile.length > 0, `per-file line(s) for ${step.name} in the standards report`);
  check(summary !== undefined, `summary line for ${step.name} in the standards report`);
  const statuses = new Set(perFile.map((l) => (l.split(/\s+/)[1] ?? '')));
  check([...statuses].every((s) => step.onApi.includes(s)), `${step.name} on ${API} is ${step.onApi.join('/')} (got ${[...statuses].join('/') || 'nothing'})`);
  const verdict = r.out.split('\n').find((l) => l.startsWith('verdict'));
  if (verdict !== undefined) say(`    ${verdict.trim()}`);
  if (r.code !== 0) say(`    note: verdict on ${API} is not 100% for reasons outside this extension (see the report)`);

  const f = harness('check', '--api', FIXTURE, '--rule', step.name);
  const flines = f.out.split('\n');
  const fail = flines.findIndex((l) => new RegExp(`^${step.name}\\s+FAIL\\s+src/\\S+\\.ts\\s+\\d+/\\d+ \\S+`).test(l));
  const loc = fail >= 0 ? flines[fail + 1] ?? '' : '';
  say(`    harness check --api ${FIXTURE} --rule ${step.name} → exit ${String(f.code)}:`);
  say(indent(flines.filter((l) => l.startsWith(step.name) || /^ {4}src\//.test(l)).slice(0, 14).join('\n'), 8));
  check(fail >= 0, `${step.name} prints "<rule> FAIL <file> n/m <unit>" on the violating fixture`);
  check(/^ {4}src\/\S+\.ts:\d+:\d+ {2}\S/.test(loc), `${step.name} prints each violation as "file:line:col  message"`);
  check(f.code === 1, `harness check exits 1 when ${step.name} fails`);
}

function assertToolInRun(step) {
  if (!WITH_RUN) {
    say('    (skipped the scripted run: --no-run)');
    return;
  }
  const script = join(repo, '.harness', 'simulate-tool-script.json');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, JSON.stringify({
    description: 'One turn that calls the newly dropped-in tool.',
    turns: [{ text: `Call the new ${step.name} tool.`, calls: [{ name: step.name, input: {} }] }],
  }, null, 2));
  const r = harness('run', 'tasks/projects-change.task.yaml', '--driver', 'scripted', '--driver-opt', `script=${script}`, '--max-turns', '1');
  const runsDir = join(repo, 'runs');
  const ids = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, 'run.json'))) : [];
  const id = ids[0];
  check(id !== undefined, `a scripted run was recorded (exit ${String(r.code)})${id === undefined ? `\n${indent(r.out)}` : ''}`);
  if (id === undefined) return;
  const rec = JSON.parse(readFileSync(join(runsDir, id, 'run.json'), 'utf8'));
  check(Object.hasOwn(rec.pluginFingerprint ?? {}, step.dest), `runs/${id}/run.json pluginFingerprint includes ${step.dest}`);
  const transcript = readFileSync(join(runsDir, id, 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  const first = transcript.find((t) => t.turn === 1);
  const called = (first?.assistant ?? []).some((p) => p.type === 'tool_call' && p.name === step.name);
  const result = (first?.results ?? []).find((p) => p.type === 'tool_result');
  const content = typeof result?.content === 'string' ? result.content : '';
  check(called, `turn 1 called ${step.name}`);
  check(content !== '' && !/unknown tool/.test(content), `${step.name} was offered and returned a result in the run`);
  say(indent(content.split('\n').slice(0, 6).join('\n'), 8));
  // Run evidence (runs/, tokens/) is committed by design; it is not part of the extension.
  const porcelain = git('status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l !== '');
  const outside = porcelain.map((l) => l.slice(3)).filter((p) => !p.startsWith('plugins/') && !p.startsWith('runs/') && !p.startsWith('tokens/'));
  check(outside.length === 0, `the run changed nothing outside plugins/, runs/, tokens/${outside.length > 0 ? `: ${outside.join(', ')}` : ''}`);
  // Remove the run's evidence, worktree and branch so the next step's diff is only the next plugin.
  if (typeof rec.worktreeRoot === 'string') sh('git', ['worktree', 'remove', '--force', rec.worktreeRoot]);
  if (typeof rec.branch === 'string') sh('git', ['branch', '-D', rec.branch]);
  rmSync(join(runsDir), { recursive: true, force: true });
  rmSync(join(repo, 'tokens', `${id}.json`), { force: true });
}

function assertDiff(step, baseCore, expected) {
  git('add', '-A', '--intent-to-add');
  const stat = git('diff', '--stat');
  const porcelain = git('status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l !== '');
  say('    git diff --stat');
  say(indent(stat, 8));
  say('    git status --porcelain');
  say(indent(porcelain.join('\n'), 8));
  const paths = porcelain.map((l) => l.slice(3).trim());
  check(paths.includes(step.dest), `${step.dest} is the change`);
  check(paths.every((p) => p.startsWith('plugins/')), `every changed path is under plugins/ (${paths.length} path(s): ${paths.join(', ')})`);
  check(!paths.some((p) => p.startsWith('src/core/')), 'nothing under src/core/ changed (git)');
  check(paths.length === expected.length && expected.every((e) => paths.includes(e)), `only the dropped-in files changed so far (${expected.length})`);
  check(coreHash() === baseCore, 'sha256 of src/core/** is unchanged');
}

// ───────────────────────────── main ─────────────────────────────

function main() {
  for (const s of STEPS) {
    if (!existsSync(join(ROOT, s.src))) throw new Error(`missing example ${s.src}`);
    if (existsSync(join(ROOT, s.dest))) say(`note: ${s.dest} already exists in ${ROOT}; the sandbox starts without it and adds it fresh`);
  }
  say(`sandbox: copying sources of ${ROOT}`);
  const n = makeSandbox();
  say(`sandbox: ${repo} (${n} files committed as "base")`);
  const baseCore = coreHash();
  const dropped = [];
  for (const step of STEPS) {
    say('');
    say(`━━ ${step.title}`);
    say(`    cp ${step.src} ${step.dest}`);
    mkdirSync(dirname(join(repo, step.dest)), { recursive: true });
    copyFileSync(join(repo, step.src), join(repo, step.dest));
    dropped.push(step.dest);
    assertPlugins(step);
    if (step.kind === 'check') assertCheckOnApi(step);
    assertDiff(step, baseCore, dropped);
    if (step.kind === 'tool') assertToolInRun(step);
  }
  say('');
  if (failures.length === 0) {
    say(`RESULT  pass  ${STEPS.length} extensions added by dropping one file each into plugins/; src/core/ untouched`);
  } else {
    say(`RESULT  FAIL  ${failures.length} assertion(s) failed:`);
    for (const f of failures) say(`  - ${f.split('\n')[0]}`);
  }
}

let code = 0;
try {
  main();
  code = failures.length === 0 ? 0 : 1;
} catch (e) {
  say(`RESULT  FAIL  ${e instanceof Error ? e.message : String(e)}`);
  code = 1;
} finally {
  try {
    cleanup();
  } catch (e) {
    say(`cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  }
}
process.exitCode = code;
