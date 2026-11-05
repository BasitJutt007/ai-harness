/**
 * /ship in a session: the owner ships, typed at the prompt; the model has no tool that reaches this.
 *
 * Refused unless: the last verdict was DONE, for the item bound now; the item is approved and its
 * contract unchanged; the branch is still the session's working branch, writable (not protected, no
 * operation in progress) and not the contract's Base; the working tree holds only the agent's changes
 * (a change the agent did not make would ship unreviewed by the gates) and is, byte for byte, what the
 * verdict judged: the same changed paths with the same content (git blob ids, checked before the ship
 * gates and again on what is staged). Then the ship gates run fresh (required list), the commit message
 * and PR text come from the approved contract (src/core/ship.ts shipText), and the harness:
 *   1. copies the item's records into the repository: docs/contracts/<slug>.md,
 *      .harness/items/<slug>/ledger.jsonl and .harness/items/<slug>/session.json (verdict, gates);
 *   2. stages exactly the agent's changed files and those records, and scans the staged diff for secrets;
 *   3. commits on the CURRENT branch (repository hooks off, as the harness), pushes that branch to
 *      origin with an explicit refspec and never with force, and opens the PR against the contract's
 *      Base with gh; what it cannot do is reported (status committed), never faked;
 *   4. once the PR is open, appends the session's `run` entry (verdict DONE, the approved contract hash)
 *      and then the `shipped` entry to the item ledger: `harness item close` accepts a shipped entry only
 *      after a DONE run of the approved text (close.ts shippedRunProblem).
 * A ship that committed but could not push or open the PR (status committed) returns what a retry needs
 * (`retry`); /ship with it (`resume`) commits nothing again: on the same item, contract, branch and
 * commit (HEAD exactly), it only pushes and opens the PR, then records run and shipped as above.
 * Nothing committed or sent carries an absolute local path: session.json, the commit message and the PR
 * body name the repository as ".", the state directory as "<state-dir>" and the home directory as "~".
 * Every command is an argv array (no shell). File-mode ship (src/core/ship.ts ship) is untouched.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HARNESS_ROOT } from '../core/config.ts';
import { passThroughEnv } from '../core/exec.ts';
import { requiredGates, runGates } from '../core/gates.ts';
import { branchVerdict } from '../core/inplace.ts';
import { appendLedger, itemPaths, itemStatus } from '../core/items.ts';
import { formatCommand, ghStatus, NO_HOOKS, scanDiffForSecrets, SHIP_ENV_PASS_THROUGH, shipText } from '../core/ship.ts';
import type { Exec, ExecResult, RunContext } from '../core/types.ts';
import { isProtectedBranch, normalizeBranch } from '../core/workspace.ts';
import { fingerprintDiff, verdictRecord, type SessionVerdict, type TreeFingerprint } from './verdict.ts';

export interface SessionShipOptions {
  ctx: RunContext;
  /** The repository top (real path). */
  top: string;
  sessionId: string;
  lastVerdict: SessionVerdict | null;
  /** Extra facts for session.json (model, spend, ...). */
  summary: Record<string, unknown>;
  /** The repository's state directory (named "<state-dir>" in what is committed or sent). */
  stateRoot?: string;
  /** Remote to push to (default origin). */
  remote?: string;
  /** Push and open the PR for the commit an earlier /ship made (its `retry`), committing nothing. */
  resume?: ShipResume;
}

/** A commit /ship made for an item and could not push or open a PR for. */
export interface ShipResume {
  slug: string;
  contractHash: string;
  sha: string;
  /** The PR title and body made when it was committed (no absolute local path in them). */
  title: string;
  body: string;
}

export interface SessionShipResult {
  status: 'shipped' | 'committed' | 'refused';
  branch: string;
  commit?: string;
  prUrl?: string;
  reasons: string[];
  /** Every command run, in order, as printable argv lines. */
  commands: string[];
  /** status committed: what /ship needs to push it and open the PR later. */
  retry?: ShipResume;
}

/** Repository-relative paths with a change in the working tree (porcelain v1, -z; renames give both sides). */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\u0000');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] ?? '';
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy.includes('R') || xy.includes('C')) {
      const from = parts[i + 1];
      if (from !== undefined && from.length > 0) paths.push(from);
      i += 1;
    }
  }
  return [...new Set(paths)].sort();
}

/** The paths the session's verdict and ship compare: what `git status` shows changed (untracked included). */
export async function changedPaths(ctx: Pick<RunContext, 'exec'>, top: string): Promise<string[] | null> {
  const r = await ctx.exec('git', ['-C', top, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: top, timeoutMs: 60_000 });
  return r.code === 0 ? parsePorcelainZ(r.stdout) : null;
}

/**
 * The content of each path, as git would stage it: a regular file's blob id (`git hash-object`, the
 * repository's filters applied), 'deleted' for a path that is gone, a marker for a link or anything
 * else. Null when git cannot hash them.
 */
export async function treeFingerprint(exec: Exec, top: string, paths: readonly string[]): Promise<TreeFingerprint | null> {
  const fp: TreeFingerprint = {};
  const files: string[] = [];
  for (const p of paths) {
    const abs = join(top, p);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (st === undefined) fp[p] = 'deleted';
    else if (st.isSymbolicLink()) fp[p] = `link:${createHash('sha256').update(readlinkSync(abs)).digest('hex')}`;
    else if (st.isFile()) files.push(p);
    else fp[p] = st.isDirectory() ? 'directory' : 'special';
  }
  if (files.length > 0) {
    const r = await exec('git', ['-C', top, 'hash-object', '--', ...files], { cwd: top, timeoutMs: 60_000 });
    const ids = r.stdout.trim().split('\n');
    if (r.code !== 0 || ids.length !== files.length) return null;
    files.forEach((f, i) => {
      fp[f] = ids[i] ?? '';
    });
  }
  return fp;
}

/** Where the item's records go in the repository. */
export function recordPaths(slug: string): { contract: string; ledger: string; session: string } {
  return { contract: `docs/contracts/${slug}.md`, ledger: `.harness/items/${slug}/ledger.jsonl`, session: `.harness/items/${slug}/session.json` };
}

/**
 * `text` without the absolute local paths a session knows: the repository top becomes ".", the state
 * directory "<state-dir>", the harness checkout "<harness>", the home directory "~". A root is replaced
 * only where it stands as a path of its own: not preceded by a path character, and followed by "/", the
 * end, or anything that cannot continue a path name (a "." only when nothing path-like follows it). So
 * a checkout at /app leaves "src/app/page.tsx" and "/application" alone. One pass, longest root first,
 * so a replacement is never matched again.
 */
export function scrubPaths(text: string, roots: { top: string; stateRoot?: string | undefined; harnessRoot?: string | undefined; home?: string | undefined }): string {
  const pairs: Array<[string, string]> = [
    [roots.top, '.'],
    ...(roots.stateRoot !== undefined ? [[roots.stateRoot, '<state-dir>'] as [string, string]] : []),
    ...(roots.harnessRoot !== undefined ? [[roots.harnessRoot, '<harness>'] as [string, string]] : []),
    [roots.home ?? homedir(), '~'],
  ];
  const usable = pairs.map(([f, t]): [string, string] => [f.replace(/\/+$/, ''), t]).filter(([f]) => f.length > 1).sort((a, b) => b[0].length - a[0].length);
  if (usable.length === 0) return text;
  const to = new Map(usable);
  const alternatives = usable.map(([f]) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const root = new RegExp(`(?<![\\w./-])(?:${alternatives})(?![\\w-]|\\.[\\w.-])`, 'g');
  return text.replace(root, (m) => to.get(m) ?? m);
}

function firstLine(r: ExecResult): string {
  return (r.stderr.trim() || r.stdout.trim()).split('\n')[0] ?? '';
}

export async function sessionShip(o: SessionShipOptions): Promise<SessionShipResult> {
  const { ctx, top } = o;
  const remote = o.remote ?? 'origin';
  const branch = ctx.inPlace?.branch ?? ctx.run.branch;
  const commands: string[] = [];
  const refuse = (...reasons: string[]): SessionShipResult => ({ status: 'refused', branch, reasons, commands });
  const run = async (cmd: string, args: string[], record = true): Promise<ExecResult> => {
    if (record) commands.push(formatCommand(cmd, args));
    return ctx.exec(cmd, args, { cwd: top, timeoutMs: 120_000, env: passThroughEnv(SHIP_ENV_PASS_THROUGH) });
  };
  const git = (args: string[], record = true): Promise<ExecResult> => run('git', ['-C', top, ...args], record);
  const scrub = (text: string): string => scrubPaths(text, { top, stateRoot: o.stateRoot, harnessRoot: HARNESS_ROOT });

  // 1. What the owner can ship: a DONE verdict on the approved, unchanged item, on the working branch
  //    (a retry of a commit /ship already made needs no new verdict: what it pushes was judged then).
  const item = ctx.item;
  if (item === undefined) return refuse('no approved contract is bound to this session: propose one, approve it, let the gates say DONE, then /ship');
  const v = o.lastVerdict;
  if (o.resume === undefined) {
    if (v === null || v.kind !== 'DONE') return refuse(`the last verdict is ${v === null ? 'none yet' : v.kind}: /ship needs DONE (the agent's accepted finish, or /gates)`);
    if (v.item?.contractHash !== item.contractHash) return refuse('the last DONE verdict was about another contract: run /gates for this one');
  }
  const status = itemStatus(item.root, item.slug);
  if (!status.editable || status.contract.parse === null) return refuse(`item ${item.slug} is not approved (${status.stage}): ${status.lines.join(' | ')}`);
  if (status.contract.parse.hash !== item.contractHash) return refuse(`docs/contracts/${item.slug}.md changed after it was approved: propose it again`);
  const base = (status.contract.parse.fields.Base ?? '').trim();
  const bv = await branchVerdict(top, ctx.config, ctx.exec);
  if (!bv.writable) return refuse(`${bv.reason}; ${bv.fix}`);
  if (bv.branch !== branch) return refuse(`HEAD is on ${bv.branch ?? 'another commit'}, not ${branch} where the session started: switch back (git switch ${branch})`);
  if (isProtectedBranch(branch, ctx.config.protectedBranches)) return refuse(`refusing to ship protected branch "${branch}"`);
  if (normalizeBranch(branch).toLowerCase() === normalizeBranch(base).toLowerCase()) return refuse(`the branch ${branch} is the contract's Base: cut a working branch (git switch -c <name>) for the PR`);

  /** Push `sha` (HEAD of the branch), open the PR, then record the run and the shipped entry. */
  const publish = async (sha: string, title: string, body: string): Promise<SessionShipResult> => {
    const retry: ShipResume = { slug: item.slug, contractHash: item.contractHash, sha, title, body };
    const committed = (reasons: string[]): SessionShipResult => ({ status: 'committed', branch, commit: sha, reasons, commands, retry });
    // 7. Push the current branch only: explicit refspec, never force.
    if ((await git(['remote', 'get-url', remote], false)).code !== 0) return committed([`no remote "${remote}": committed ${sha.slice(0, 12)} on ${branch}, not pushed`]);
    const push = await git([...NO_HOOKS, 'push', '--no-force', '-u', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    if (push.code !== 0) return committed([`push to ${remote} failed: ${firstLine(push)}`]);
    // 8. The PR against the contract's Base.
    const gh = await ghStatus((args) => run('gh', args, false));
    if (!gh.ok) return committed([`pushed ${branch} to ${remote}; ${gh.why}, so no PR was opened`]);
    const pr = await run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]);
    if (pr.code !== 0) return committed([`pushed ${branch} to ${remote}; gh pr create failed: ${firstLine(pr)}`]);
    const url = [...pr.stdout.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]).pop();
    // 9. The run that cleared it, then the shipped entry: close accepts a shipped line only after a DONE run of this text.
    appendLedger(paths.ledger, { type: 'run', runId: o.sessionId, status: 'done', verdict: 'DONE', contractHash: item.contractHash });
    appendLedger(paths.ledger, { type: 'shipped', runId: o.sessionId, branch, headSha: sha, base, prUrl: url ?? null });
    return { status: 'shipped', branch, commit: sha, ...(url !== undefined ? { prUrl: url } : {}), reasons: url !== undefined ? [] : ['gh pr create succeeded but printed no URL'], commands };
  };
  const paths = itemPaths(item.root, item.slug);

  // A retry: the commit /ship made for this item, still exactly HEAD; nothing is committed again.
  if (o.resume !== undefined) {
    const c = o.resume;
    if (c.slug !== item.slug || c.contractHash !== item.contractHash) return refuse(`the commit /ship made was for ${c.slug} (contract ${c.contractHash.slice(0, 12)}), not the item bound now: nothing was pushed`);
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], false)).stdout.trim();
    if (head !== c.sha) {
      return refuse(`HEAD is ${head.slice(0, 12) || 'unknown'}, not ${c.sha.slice(0, 12)}, the commit /ship made for ${item.slug}: nothing was pushed. Put ${branch} back on that commit, or push and open the PR yourself`);
    }
    return publish(c.sha, c.title, c.body);
  }
  if (v === null) return refuse('no verdict yet: /ship needs DONE');

  // 2. The tree holds the agent's work only, and is, byte for byte, the tree the verdict judged.
  const changed = await changedPaths(ctx, top);
  if (changed === null) return refuse('git status failed: the working tree could not be read');
  const written = new Set(ctx.state.written);
  const foreign = changed.filter((p) => !written.has(p));
  if (foreign.length > 0) {
    return refuse(`the working tree has changes the agent did not make (${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', ...' : ''}): commit or set them aside yourself, then /gates and /ship`);
  }
  if (changed.length === 0) return refuse('nothing to commit: the working tree has no change');
  if (changed.join('\n') !== [...v.changed].sort().join('\n')) return refuse('the working tree changed since the DONE verdict: run /gates again');
  const now = await treeFingerprint(ctx.exec, top, changed);
  if (now === null) return refuse('the changed files could not be hashed (git hash-object failed): nothing was shipped');
  const differs = fingerprintDiff(v.fingerprint, now);
  if (differs.length > 0) return refuse(`${differs.slice(0, 5).join(', ')}${differs.length > 5 ? ', ...' : ''} changed since the verdict; run /gates`);

  // 3. The ship gates, fresh, then the commit and PR text from the approved contract.
  const gates = await runGates(ctx.registry.gates, ctx, 'ship', { required: requiredGates(ctx.task, 'ship', ctx.stack) });
  if (!gates.ok) return refuse('the ship gates are not green (re-run fresh):', ...gates.compact.split('\n'));
  const text = await shipText(ctx, gates, { contract: 'committed in this PR, with the item ledger under .harness/items/' });
  if ('refuse' in text) return refuse(...text.refuse);
  const message = scrub(text.message);
  const body = scrub(text.body);

  // 4. The item's records, copied into the repository (removed again if the ship stops before the commit).
  const rec = recordPaths(item.slug);
  const contractText = readFileSync(paths.contract, 'utf8');
  const repoContract = join(top, rec.contract);
  if (existsSync(repoContract) && readFileSync(repoContract, 'utf8') !== contractText) {
    return refuse(`${rec.contract} already exists in the repository with other text: the item's contract cannot be committed there`);
  }
  const summary = {
    session: o.sessionId,
    item: { slug: item.slug, contractHash: item.contractHash },
    branch,
    baseSha: ctx.run.baseSha,
    verdict: verdictRecord(v),
    shipGates: Object.fromEntries(gates.results.map((g) => [g.gate, g.status])),
    ...o.summary,
  };
  const created: string[] = [];
  const put = (rel: string, content: string): void => {
    const abs = join(top, rel);
    if (!existsSync(abs)) created.push(abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const undo = async (): Promise<void> => {
    await git(['reset', '-q', '--', ...changed, rec.contract, rec.ledger, rec.session], false);
    for (const f of created) rmSync(f, { force: true });
  };
  put(rec.contract, contractText);
  put(rec.ledger, readFileSync(paths.ledger, 'utf8'));
  put(rec.session, `${scrub(JSON.stringify(summary, null, 2))}\n`);

  // 5. Stage exactly the agent's files and the records; nothing else may be staged.
  const add = await git(['add', '--all', '--', ...changed]);
  if (add.code !== 0) {
    await undo();
    return refuse(`git add failed: ${firstLine(add)}`);
  }
  const addRecords = await git(['add', '--force', '--', rec.contract, rec.ledger, rec.session]);
  if (addRecords.code !== 0) {
    await undo();
    return refuse(`git add of the item records failed: ${firstLine(addRecords)}`);
  }
  const staged = await git(['diff', '--cached', '--name-only', '-z'], false);
  const expected = new Set([...changed, rec.contract, rec.ledger, rec.session]);
  const extra = staged.stdout.split('\u0000').filter((p) => p.length > 0 && !expected.has(p));
  if (staged.code !== 0 || extra.length > 0) {
    await undo();
    return refuse(staged.code !== 0 ? `git diff --cached failed: ${firstLine(staged)}` : `other paths are staged (${extra.slice(0, 5).join(', ')}): unstage them first`);
  }
  // What is staged is what the verdict judged (a file changed between the check above and git add is caught here).
  const index = await git(['ls-files', '-s', '-z', '--', ...changed], false);
  if (index.code !== 0) {
    await undo();
    return refuse(`git ls-files failed: ${firstLine(index)}`);
  }
  const stagedIds = new Map<string, string>();
  for (const e of index.stdout.split('\u0000').filter((x) => x.length > 0)) {
    const tab = e.indexOf('\t');
    stagedIds.set(e.slice(tab + 1), e.slice(0, tab).split(' ')[1] ?? '');
  }
  const stagedDiffers = changed.filter((p) => (v.fingerprint[p] === 'deleted' ? stagedIds.has(p) : stagedIds.get(p) !== v.fingerprint[p]));
  if (stagedDiffers.length > 0) {
    await undo();
    return refuse(`${stagedDiffers.slice(0, 5).join(', ')} changed since the verdict; run /gates`);
  }
  const diff = await git(['diff', '--cached', '--no-color', '-U0']);
  if (diff.code !== 0) {
    await undo();
    return refuse(`could not read the staged diff for the secret scan: ${firstLine(diff)}`);
  }
  const secrets = scanDiffForSecrets(diff.stdout);
  if (secrets.length > 0) {
    await undo();
    return refuse('possible secrets in the staged diff (unstaged again):', ...secrets.slice(0, 20));
  }

  // 6. Commit on the current branch, as the harness.
  const commit = await git([...NO_HOOKS, '-c', 'user.name=sf-harness', '-c', 'user.email=harness@localhost', 'commit', '-q', '-m', message]);
  if (commit.code !== 0) {
    await undo();
    return refuse(`git commit failed: ${firstLine(commit)}`);
  }
  const sha = (await git(['rev-parse', 'HEAD'], false)).stdout.trim();
  // 7-9. Push, the PR, the ledger (a failure there leaves the commit, and says how to retry).
  return publish(sha, text.title, body);
}
