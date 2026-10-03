/**
 * Ship: the harness ships, the agent never does.
 *
 * Re-runs every gate (phase 'ship', fresh — cached results are never trusted),
 * refuses protected/base branches, stages ONLY the API root, scans the staged
 * diff for secrets, commits as the harness, pushes the feature branch with an
 * explicit refspec (never force) and opens a PR when `gh` is installed and
 * authenticated. Anything it cannot do is reported honestly as 'committed'
 * with reasons. No shell is ever involved: every command is an argv array.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { passThroughEnv } from './exec.ts';
import { runGates } from './gates.ts';
import type { GateOutcome } from './gates.ts';
import type { ExecResult, RegistryView, RunContext } from './types.ts';
import { isProtectedBranch, normalizeBranch } from './workspace.ts';

export interface ShipResult {
  status: 'shipped' | 'committed' | 'refused' | 'dry-run';
  branch: string;
  commit?: string;
  prUrl?: string;
  reasons: string[];
  /** Commands executed (or, for a dry run, planned), in order, as printable argv lines. */
  commands?: string[];
  /** The ship-phase gates this call re-ran fresh (set once they ran green, e.g. on a dry run). */
  gates?: { ok: boolean; text: string };
}

export interface ShipOptions {
  ctx: RunContext;
  registry: RegistryView;
  dryRun: boolean;
  /** Remote to push to (default "origin"). */
  remote?: string;
}

const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

/**
 * Credential-shaped variables ship's own git / gh calls may see (exec strips them from every other
 * trusted child, and confined agent code never gets them): the SSH agent socket for `git push`
 * over SSH and the forge tokens `gh pr create` authenticates with.
 */
export const SHIP_ENV_PASS_THROUGH = ['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

/**
 * Repository hooks are not run for the harness's own commit and push: they would
 * execute repository (and agent-written test) code outside the harness's runner.
 * The gates, re-run fresh above, are the policy. (The agent can only write .ts
 * files under the API root, so it can never create or alter a hook itself.)
 */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

/** Minimal key-like content scan (core cannot import plugins; the `secrets` gate does the full scan). */
const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'PEM private key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { label: 'sk- style API key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'hard-coded api key', re: /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i },
];

/** Scan the added lines of a unified diff; returns redacted `file:line  label` findings. */
export function scanDiffForSecrets(diff: string): string[] {
  const found: string[] = [];
  let file = '';
  let line = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l.slice(4).replace(/^b\//, '');
    } else if (l.startsWith('@@')) {
      const m = /\+(\d+)/.exec(l);
      line = m?.[1] !== undefined ? Number(m[1]) : 0;
    } else if (l.startsWith('+')) {
      for (const p of SECRET_PATTERNS) {
        const m = p.re.exec(l.slice(1));
        if (m) found.push(`${file}:${line}  ${p.label} ${m[0].slice(0, 4)}…(${m[0].length} chars)`);
      }
      line++;
    } else if (!l.startsWith('-') && !l.startsWith('\\')) {
      line++;
    }
  }
  return found;
}

/** Printable argv line (arguments with unsafe characters are JSON-quoted). */
export function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function firstLine(r: ExecResult): string {
  return (r.stderr.trim() || r.stdout.trim()).split('\n')[0] ?? '';
}

/**
 * Content fingerprint of everything `git add --all -- <pathspec>` would consider
 * (tracked + untracked-not-ignored), so ship can prove the tree it commits is the
 * tree its gates just evaluated.
 */
async function treeFingerprint(
  git: (args: string[], record?: boolean) => Promise<ExecResult>,
  repo: string,
  pathspec: string[],
): Promise<string | null> {
  const ls = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspec], false);
  if (ls.code !== 0) return null;
  const h = createHash('sha256');
  for (const p of [...new Set(ls.stdout.split('\u0000').filter((x) => x !== ''))].sort()) {
    h.update(`${p}\u0000`);
    const abs = join(repo, p);
    try {
      const st = lstatSync(abs);
      h.update(st.isSymbolicLink() ? `link:${readlinkSync(abs)}` : st.isFile() ? readFileSync(abs) : `other:${st.mode}`);
    } catch {
      h.update('missing');
    }
    h.update('\u0000');
  }
  return h.digest('hex');
}

/**
 * The run's standards report verdict plus its n/a rules (never counted, never green), and the
 * ship-phase standards gate result, which decides: ORM/lint rules block only in changed files.
 */
function standardsVerdict(ctx: RunContext, gates: GateOutcome): string {
  const lines: string[] = [];
  const file = join(ctx.run.runDir, 'standards.txt');
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').split('\n');
    const verdict = text.find((l) => l.startsWith('verdict'));
    if (verdict !== undefined) lines.push(verdict.trim());
    const sep = text.findIndex((l) => l.startsWith('─'));
    const na = sep === -1 ? [] : text.slice(sep + 1).filter((l) => /^\S+\s+n\/a\s/.test(l)).map((l) => l.split(/\s+/)[0] ?? '');
    if (na.length > 0) lines.push(`n/a (nothing to check, not counted): ${na.join(', ')}`);
  }
  const g = gates.results.find((r) => r.gate === 'standards');
  if (g !== undefined) lines.push(`standards gate (ship): ${g.status} ${g.summary}`);
  return lines.length > 0 ? lines.join('\n\n') : 'standards verdict: not recorded';
}

function tokenTotals(ctx: RunContext): string {
  // tokensDir may be absolute (an evidence-dir override) or harness-relative.
  const file = resolve(ctx.run.harnessRoot, ctx.config.tokensDir, `${ctx.run.id}.json`);
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(raw) && isRecord(raw.totals)) {
      const t = raw.totals;
      return `actual ${String(t.actual_input_tokens)} vs baseline ${String(t.baseline_input_tokens)} input tokens (reduction ${String(t.reduction_pct)}%)`;
    }
  } catch {
    // not recorded
  }
  return 'not recorded';
}

function commitMessage(ctx: RunContext, gates: GateOutcome): string {
  return [
    `harness(${ctx.task.id}): ${ctx.task.title}`,
    '',
    `run: ${ctx.run.id}`,
    `task: ${ctx.task.id} (${ctx.task.kind})`,
    `driver: ${ctx.run.driver} / ${ctx.run.model}`,
    '',
    'gates (re-run at ship):',
    gates.text,
  ].join('\n');
}

/** Run directory relative to the harness root (absolute when it lives outside it). */
function evidencePath(ctx: RunContext): string {
  const rel = relative(ctx.run.harnessRoot, ctx.run.runDir);
  const p = rel === '' || rel.startsWith('..') || isAbsolute(rel) ? ctx.run.runDir : rel;
  return sep === '/' ? p : p.split(sep).join('/');
}

export function prBody(ctx: RunContext, gates: GateOutcome): string {
  return [
    `Opened by sf-harness for run \`${ctx.run.id}\`.`,
    '',
    `Task: **${ctx.task.id}** ${ctx.task.title} (${ctx.task.kind})`,
    '',
    '### Gates (re-run fresh at ship)',
    '```',
    gates.text,
    '```',
    '',
    '### Standards',
    standardsVerdict(ctx, gates),
    '',
    '### Tokens',
    tokenTotals(ctx),
    '',
    `Run evidence: ${evidencePath(ctx)}/`,
  ].join('\n');
}

export async function ship(opts: ShipOptions): Promise<ShipResult> {
  const { ctx, dryRun } = opts;
  const ws = ctx.workspace;
  const repo = ws.repoRoot;
  const branch = ctx.run.branch;
  const base = ctx.run.baseBranch;
  const remote = opts.remote ?? 'origin';
  const commands: string[] = [];

  const run = async (cmd: string, args: string[], record = true): Promise<ExecResult> => {
    if (record) commands.push(formatCommand(cmd, args));
    return ctx.exec(cmd, args, { cwd: repo, timeoutMs: 120_000, env: passThroughEnv(SHIP_ENV_PASS_THROUGH) });
  };
  const git = (args: string[], record = true): Promise<ExecResult> => run('git', ['-C', repo, ...args], record);
  const refuse = (...reasons: string[]): ShipResult => ({ status: 'refused', branch, reasons, commands });

  // 1. Branch safety (never a protected branch, never the base branch, never another branch).
  if (!SAFE_REF.test(branch) || branch.startsWith('-') || /^(refs|heads)\//i.test(branch) || /^head$/i.test(branch)) {
    return refuse(`invalid branch name "${branch}": use a plain feature branch name such as harness/<task>`);
  }
  if (isProtectedBranch(branch, ctx.config.protectedBranches)) return refuse(`refusing to ship protected branch "${branch}"`);
  if (normalizeBranch(branch).toLowerCase() === normalizeBranch(base).toLowerCase()) {
    return refuse(`refusing to ship: branch "${branch}" is the base branch`);
  }
  if (!SAFE_REF.test(remote) || remote.startsWith('-')) return refuse(`invalid remote name "${remote}"`);
  const refOk = await git(['check-ref-format', '--branch', branch], false);
  if (refOk.code !== 0) return refuse(`invalid branch name "${branch}": ${firstLine(refOk)}`);
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], false);
  if (head.code !== 0) return refuse(`cannot read the worktree branch: ${firstLine(head)}`);
  if (head.stdout.trim() !== branch) return refuse(`worktree is on "${head.stdout.trim()}", not the run branch "${branch}"`);

  const rootRel = ws.rootRel === '' || ws.rootRel === '.' ? '' : ws.rootRel.replace(/\/+$/, '');
  const pathspec = rootRel === '' ? '.' : rootRel;
  const prefix = rootRel === '' ? '' : `${rootRel}/`;
  const excludes = [':(exclude,glob)**/node_modules', ':(exclude,glob)**/node_modules/**'];

  // 2. Gates, fresh — over a tree we fingerprint first, so a change made while they run is caught.
  const before = await treeFingerprint(git, repo, [pathspec, ...excludes]);
  if (before === null) return refuse('cannot list the files under the API root (git ls-files failed)');
  const gates = await runGates(opts.registry.gates, ctx, 'ship');
  if (!gates.ok) return refuse('gates are not green (re-run fresh for ship):', ...gates.compact.split('\n'));

  // 3. Plan.
  const addArgs = ['add', '--all', '--', pathspec, ...excludes];
  const commitArgs = [...NO_HOOKS, '-c', 'user.name=sf-harness', '-c', 'user.email=harness@localhost', 'commit', '-q', '-m', commitMessage(ctx, gates)];
  const pushArgs = [...NO_HOOKS, 'push', '--no-force', '-u', remote, `refs/heads/${branch}:refs/heads/${branch}`];
  const title = `harness: ${ctx.task.title} (${ctx.task.id})`;
  const prArgs = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', prBody(ctx, gates)];

  const hasRemote = (await git(['remote', 'get-url', remote], false)).code === 0;

  if (dryRun) {
    const plan = [
      formatCommand('git', ['-C', repo, ...addArgs]),
      formatCommand('git', ['-C', repo, 'diff', '--cached', '--no-color', '-U0', '--', pathspec]) + '   # secret scan',
      formatCommand('git', ['-C', repo, ...commitArgs]),
      formatCommand('git', ['-C', repo, ...pushArgs]),
      formatCommand('gh', prArgs),
    ];
    const notes = ['dry run: nothing was staged, committed, pushed or opened'];
    if (!hasRemote) notes.push(`remote "${remote}" does not exist: the push and PR steps would be skipped (status committed)`);
    notes.push('the PR step depends on gh (installed and authenticated); a dry run does not invoke gh, so it is not checked here');
    const short = plan.map((p) => `plan: ${p.length > 240 ? `${p.slice(0, 240)}… (${p.length} chars)` : p}`);
    return { status: 'dry-run', branch, reasons: [...notes, ...short], commands: plan, gates: { ok: gates.ok, text: gates.text } };
  }

  // 4. Stage only the API root (refuse if anything outside it is already staged).
  const pre = await git(['diff', '--cached', '--name-only', '-z'], false);
  if (pre.code !== 0) return refuse(`git diff --cached failed: ${firstLine(pre)}`);
  const outside = pre.stdout.split('\u0000').filter((p) => p !== '' && prefix !== '' && !p.startsWith(prefix));
  if (outside.length > 0) return refuse(`paths outside the API root are staged: ${outside.slice(0, 5).join(', ')}`);
  const add = await git(addArgs);
  if (add.code !== 0) return refuse(`git add failed: ${firstLine(add)}`);
  const staged = await git(['diff', '--cached', '--name-only', '-z'], false);
  const stagedPaths = staged.stdout.split('\u0000').filter((p) => p !== '');
  if (stagedPaths.length === 0) return refuse(`nothing to commit under ${pathspec}`);
  // The staged tree must be exactly the tree the gates evaluated, and still match the worktree.
  const after = await treeFingerprint(git, repo, [pathspec, ...excludes]);
  const drift = await git(['diff', '--quiet', '--', pathspec, ...excludes], false);
  if (after !== before || drift.code !== 0) {
    await git(['reset', '-q', '--', pathspec]);
    return refuse('the API root changed while the ship gates were running (something modified files after they were checked); nothing was committed. Re-run ship.');
  }

  // 5. Secret scan of the staged diff.
  const diff = await git(['diff', '--cached', '--no-color', '-U0', '--', pathspec]);
  if (diff.code !== 0) {
    await git(['reset', '-q', '--', pathspec]);
    return refuse(`could not read the staged diff for the secret scan: ${firstLine(diff)}`);
  }
  const secrets = scanDiffForSecrets(diff.stdout);
  if (secrets.length > 0) {
    await git(['reset', '-q', '--', pathspec]);
    return refuse(`possible secrets in the staged diff (unstaged again):`, ...secrets.slice(0, 20));
  }

  // 6. Commit as the harness.
  const commit = await git(commitArgs);
  if (commit.code !== 0) return refuse(`git commit failed: ${firstLine(commit)}`);
  const sha = (await git(['rev-parse', 'HEAD'], false)).stdout.trim();
  const committed = (reasons: string[]): ShipResult => ({ status: 'committed', branch, commit: sha, reasons, commands });

  // 7. Push the feature branch only, explicit refspec, never force.
  if (!hasRemote) return committed([`no remote "${remote}": committed ${sha.slice(0, 12)} on ${branch}, not pushed`]);
  const push = await git(pushArgs);
  if (push.code !== 0) return committed([`push to ${remote} failed: ${firstLine(push)}`]);

  // 8. Pull request.
  const gh = await ghStatus((args) => run('gh', args, false));
  if (/^head$/i.test(base)) return committed([`pushed ${branch} to ${remote}; the run started from a detached HEAD, so there is no base branch for a PR`]);
  if (!gh.ok) return committed([`pushed ${branch} to ${remote}; ${gh.why}, so no PR was opened`]);
  const pr = await run('gh', prArgs);
  if (pr.code !== 0) return committed([`pushed ${branch} to ${remote}; gh pr create failed: ${firstLine(pr)}`]);
  const url = [...pr.stdout.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]).pop();
  return {
    status: 'shipped',
    branch,
    commit: sha,
    ...(url !== undefined ? { prUrl: url } : {}),
    reasons: url !== undefined ? [] : ['gh pr create succeeded but printed no URL'],
    commands,
  };
}

async function ghStatus(gh: (args: string[]) => Promise<ExecResult>): Promise<{ ok: boolean; why: string }> {
  const version = await gh(['--version']);
  if (version.code !== 0) return { ok: false, why: 'gh CLI is not installed' };
  const auth = await gh(['auth', 'status']);
  if (auth.code !== 0) return { ok: false, why: 'gh is not authenticated (gh auth login, or GH_TOKEN / GITHUB_TOKEN in the environment)' };
  return { ok: true, why: '' };
}
