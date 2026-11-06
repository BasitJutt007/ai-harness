/**
 * The interactive session: `harness` in any git repository.
 *
 * One session per checkout (a lock in the repository's state directory), on the repository's top
 * level, in the owner's own working tree on the branch they are on. Records stay outside the repository
 * (state-home.ts): sessions/<sid>/ is the run directory (run.json, events.jsonl, transcript.jsonl,
 * state.json, logs/, initial/), plus tokens/ and the items root.
 *
 * Every owner line is chat, sent to the model through the same governed loop as file mode (hooks on
 * every call; the gates decide). Three things are not chat:
 *   - a one-line message starting with "/" is a command, typed by the owner only (the model has no tool
 *     for any);
 *   - the ONE message typed right after a proposal is shown is the reply to it (what was typed before
 *     the box is cleared first): it goes to recordReply with the input's own channel ('tty' only when
 *     typed at a terminal), and only it can approve. Only then is the Measure's before value read;
 *   - Ctrl-C cancels the running turn; while the harness itself works (the gates, the test baseline,
 *     the before reading, /ship, /import, /status, /diff) it says what it finishes first, and never
 *     ends the process. Ctrl-C twice on an empty prompt, or Ctrl-D, ends the session.
 * Until a contract is approved every edit is refused (problem-gate, contract-gate: no item is bound),
 * and while a proposal awaits its reply nothing is written (session-pending-proposal). A contract for
 * another item never takes over the bound item's unshipped work (changes in the tree, or a commit /ship
 * made and could not push): it is refused when proposed, and a yes for it is not recorded.
 * When the model's finish is accepted, and at the end of any turn after which the tree differs from
 * what the last verdict judged, every required gate runs again, fresh, and the verdict comes from them,
 * never from the model's words; leaving with work no gate has judged says UNPROVEN and names it. A
 * refusal the model cannot fix (the checkout, the branch, the sandbox, a missing tool) ends its turn.
 * A turn that ends without finish, changed the tree and got a NOT DONE the agent can act on (the
 * standards findings it introduced, its tests, its observed red) continues by itself with the verdict's
 * reasons, at most AUTO_CONTINUE_LIMIT times per owner message (autoContinue says when never). The same
 * pre-tool refusal (hook, path, reason) STUCK_REFUSALS times within one owner message ends the model's
 * turn too: the owner is told it is stuck and says what to do differently.
 * The session never commits or pushes; /ship does, when typed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { selectChecks } from '../core/checks.ts';
import { HARNESS_ROOT, loadConfig } from '../core/config.ts';
import { exec as coreExec } from '../core/exec.ts';
import { missingRequiredHooks } from '../core/hooks.ts';
import { saveInitial } from '../core/initial.ts';
import { inPlaceWritability, branchVerdict, type InPlaceVerdict } from '../core/inplace.ts';
import { classifyReply, itemStatus, recordReply } from '../core/items.ts';
import { runAgent, type AgentResult, type AgentStatus } from '../core/loop.ts';
import { toolSpecs } from '../core/registry.ts';
import { buildContext, JIT_MODE, loadRegistryOrThrow, targetProfile } from '../core/run.ts';
import { newRunState, RunStore, serializeState } from '../core/run-store.ts';
import { isolationInfo, isolationUnavailable, sandboxMode, setConfinedRoot, setSandboxMode, type IsolationInfo } from '../core/sandbox.ts';
import { modelAllowed, modelPolicyVerdict, normalizeModel, SpendMeter, spendLine, usd } from '../core/spend.ts';
import { acquireCheckoutLock, repoStateDir, type RepoStateDir } from '../core/state-home.ts';
import { defaultScopeAllow, profileRecord, type TargetProfile } from '../core/target.ts';
import { parseTask } from '../core/task.ts';
import { describeTestBaseline, measureTestBaseline } from '../core/test-baseline.ts';
import { TokenLedger } from '../core/tokens.ts';
import type { TranscriptTurn } from '../core/context.ts';
import type { Driver, Exec, HarnessConfig, HookPlugin, Message, PluginRecord, RegistryView, RunContext, RunEvent, RunState, Task, TestBaseline, ToolEffect, ToolResult, ToolSpec, Workspace } from '../core/types.ts';
import { createWorkspace, isEnvPath } from '../core/workspace.ts';
import { toApiRel } from '../../plugins/lib/path-policy.ts';
import { personName, proposeDrafted, proposeImported, readBefore, tildePath, type Proposal, type ProposalEnv } from './contract.ts';
import type { OwnerInput } from './input.ts';
import { allowlistedModels, pickModel, type ModelRequest } from './models.ts';
import { sessionOpening, sessionSystemPrompt } from './prompt.ts';
import { changedPaths, sessionShip, treeFingerprint, type ShipResume } from './ship.ts';
import { clip, colorEnabled, Ui, type Output } from './ui.ts';
import { computeVerdict, fingerprintDiff, movedVerdict, verdictRecord, type SessionVerdict, type TreeFingerprint, type VerdictTrigger } from './verdict.ts';

/** Turns the model may take for one owner message before the prompt comes back. */
export const DEFAULT_TURNS_PER_MESSAGE = 40;
/** A session's changed-lines budget (the diff-budget gate): generous, still reviewable. */
export const SESSION_MAX_DIFF_LINES = 800;
/** Hooks a session refuses to start without, on top of the required ones: path-guard keeps every write to its scope (never a git-ignored or .env* file). */
export const SESSION_REQUIRED_HOOKS = ['path-guard'] as const;
/** Hooks whose refusal the model cannot fix (the checkout or branch moved): its turn ends there. */
const ENVIRONMENT_HOOKS: ReadonlySet<string> = new Set(['branch-guard']);
/** How many earlier sessions keep their run-start copies (initial/); older copies are removed at startup. */
export const KEEP_SESSION_COPIES = 5;

export interface SessionDeps {
  /** Where the owner started (any directory inside the repository). */
  cwd: string;
  input: OwnerInput;
  output: Output;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  config?: HarnessConfig;
  registry?: RegistryView;
  /** A ready driver (tests, demos); else `model` picks one. */
  driver?: Driver;
  model?: ModelRequest;
  /** Turns per owner message (default DEFAULT_TURNS_PER_MESSAGE). */
  maxTurns?: number;
  /** Measures the repository's own suite when an item is approved (default measureTestBaseline). */
  measureBaseline?: (ctx: RunContext) => Promise<TestBaseline>;
  sessionId?: string;
  isolation?: IsolationInfo;
  /** The OS user name (the Stakeholder when git has no user.name; default os.userInfo). */
  osUser?: () => string;
}

export interface SessionResult {
  code: number;
  sessionId?: string;
  sessionDir?: string;
}

interface Pending extends Proposal {
  imported: boolean;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A session id: UTC date-time and 4 random hex digits (lower case, usable in a task id). */
export function newSessionId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `${iso}-${randomBytes(2).toString('hex')}`;
}

/** The session's synthetic brownfield task: the whole repository, baseline standards, scope from its layout. */
export function sessionTask(sessionId: string): Task {
  return parseTask(
    {
      kind: 'brownfield',
      id: `session-${sessionId}`.toLowerCase(),
      title: 'interactive session',
      target: '.',
      change: "The owner's requests in this interactive session, under the contract they approve.",
      // Pre-existing debt in the owner's repository never blocks: only what the session introduces does.
      standards: 'baseline',
      limits: { maxOutputTokens: 16000, maxDiffLines: SESSION_MAX_DIFF_LINES },
    },
    'session task',
  );
}

/**
 * The run-start hash of every git-visible file. Nothing is copied: a writable session starts from a
 * clean tree, and the content a revert check needs is kept lazily, right before a file's first write
 * (initialCopyHook).
 */
export async function startHashes(ws: Workspace, files: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of [...files].sort()) {
    const content = await ws.read(f);
    if (content !== null) out.set(f, sha256(content));
  }
  return out;
}

/**
 * A session-only pre-write hook (it runs after every registered hook passed, so only for a write that
 * happens): before a file's first write it keeps the file's run-start content under <runDir>/initial
 * (what the observed-red gate's revert check reads), from the file itself while it still matches its
 * run-start hash, else from the session's start commit. It never blocks; a content it cannot recover is
 * simply missing, and the gate that needs it says UNPROVEN.
 */
export function initialCopyHook(o: { runDir: string; top: string; baseSha: string; exec: Exec; state: () => RunState }): PluginRecord<HookPlugin> {
  return {
    plugin: {
      kind: 'hook',
      name: 'session-initial-copy',
      description: 'Keeps a file\'s run-start content before its first write in a session (the observed-red revert check reads it).',
      events: ['pre_tool'],
      effects: ['write'],
      async run(event, ctx) {
        if (event.event !== 'pre_tool') return { decision: 'pass' };
        for (const p of event.call.paths) {
          const r = toApiRel(ctx.workspace, p);
          if (!r.ok) continue;
          const hash = o.state().initialHashes.get(r.rel);
          if (hash === undefined || existsSync(join(o.runDir, 'initial', hash))) continue;
          let content = await ctx.workspace.read(r.rel).catch(() => null);
          if (content === null || sha256(content) !== hash) {
            const g = o.baseSha.length > 0 ? await o.exec('git', ['-C', o.top, 'cat-file', 'blob', `${o.baseSha}:${r.rel}`], { cwd: o.top, timeoutMs: 30_000 }) : null;
            content = g !== null && g.code === 0 ? g.stdout : null;
          }
          if (content !== null && sha256(content) === hash) await saveInitial(o.runDir, new Map([[r.rel, content]]));
        }
        return { decision: 'pass' };
      },
    },
    file: 'src/session/session.ts',
    sha256: '0'.repeat(64),
  };
}

/**
 * A session-only pre-write hook: while a proposal awaits the owner's reply, no write happens. Without
 * it, a write in the same tool turn as a proposal for another item would land under the item still
 * bound, and the owner's yes would then bind the new contract over that change.
 */
export function pendingProposalHook(pending: () => string | null): PluginRecord<HookPlugin> {
  return {
    plugin: {
      kind: 'hook',
      name: 'session-pending-proposal',
      description: 'Refuses every write while a proposal awaits the owner\'s typed reply.',
      events: ['pre_tool'],
      effects: ['write'],
      async run(event) {
        if (event.event !== 'pre_tool') return { decision: 'pass' };
        const slug = pending();
        if (slug === null) return { decision: 'pass' };
        return { decision: 'block', reason: `write refused: proposal ${slug} awaits the owner's reply, and nothing is written until they answer it. End your turn now and wait` };
      },
    },
    file: 'src/session/session.ts',
    sha256: '0'.repeat(64),
  };
}

/** The start of the message exec raises when no sandbox can confine a command (sandbox.ts isolationUnavailable). */
const NO_ISOLATION = isolationUnavailable().message.split(':')[0] ?? 'execution isolation unavailable';

/**
 * Why a run_tests result is the environment's failure, not something the model can fix (null: it is
 * not): the repository's runner is unsupported or not installed (tests "not run (UNPROVEN)"), or no
 * sandbox can confine the run. A red test, a runner error or a refused argument is the model's to fix.
 */
export function testEnvironmentProblem(result: ToolResult): string | null {
  if (result.ok) return null;
  const first = (result.summary.split('\n')[0] ?? '').trim();
  const notRun = /^tests: not run \(UNPROVEN\): (.+)$/.exec(first);
  if (notRun !== null) return `the repository's tests cannot run here: ${notRun[1] ?? 'no supported runner'}`;
  if (result.summary.includes(NO_ISOLATION)) return `the tests cannot run here: ${NO_ISOLATION} (no sandbox confines them on this machine)`;
  return null;
}

/**
 * A session-only post-tool hook on run_tests: a failure the environment caused (testEnvironmentProblem)
 * tells the model, in the tool result itself, to stop and report, and ends its turn (`stop`).
 */
export function environmentHook(stop: (reason: string) => void): PluginRecord<HookPlugin> {
  return {
    plugin: {
      kind: 'hook',
      name: 'session-environment',
      description: 'Ends the model\'s turn when run_tests fails for a reason it cannot fix (the runner, the sandbox).',
      events: ['post_tool'],
      tools: ['run_tests'],
      async run(event) {
        if (event.event !== 'post_tool') return { decision: 'pass' };
        const why = testEnvironmentProblem(event.result);
        if (why === null) return { decision: 'pass' };
        stop(why);
        return { decision: 'record', note: `${why}. This is not something you can fix: do not retry it. Stop, tell the owner what is wrong and what they can do (for example install the repository's dependencies), and end your turn.` };
      },
    },
    file: 'src/session/session.ts',
    sha256: '0'.repeat(64),
  };
}

/** How many times one owner message may continue on its own after a NOT DONE turn verdict. */
export const AUTO_CONTINUE_LIMIT = 2;
/** Gates whose failure the agent can act on itself: the standards findings it introduced, its tests, its observed red. */
export const ACTIONABLE_GATES: ReadonlySet<string> = new Set(['standards', 'tests-green', 'observed-red']);

/** What the harness knows when a model turn ends: whether the same owner message goes on by itself. */
export interface ContinueState {
  /** How the loop ended the model's turn ('yielded': it replied without calling finish). */
  status: AgentStatus;
  /** The verdict that followed it (null: none ran, the tree did not move). */
  verdict: Pick<SessionVerdict, 'kind' | 'trigger' | 'reasons' | 'gates'> | null;
  /** A proposal awaits the owner's reply. */
  pending: boolean;
  writable: boolean;
  /** The harness ended the turn itself (a refusal the model cannot fix, or the agent was stuck). */
  stopped: boolean;
  /** The owner pressed Ctrl-C during this message (the turn, the gates, anything). */
  interrupted: boolean;
  /** Continues this owner message already had, and the reasons the last one handed over. */
  done: number;
  previous: string | null;
  /** Turns left of the message's budget. */
  turnsLeft: number;
  /** Why the next request may not be sent (the spend cap), else null. */
  spend: string | null;
}

export type ContinueDecision = { go: true; key: string } | { go: false; why: string; tell: boolean };

/**
 * Whether the owner's message goes on by itself: only when the model ended its turn without finish,
 * the tree changed, and the fresh verdict is NOT DONE because of gates the agent can act on
 * (ACTIONABLE_GATES failed, nothing else: no UNPROVEN gate, nothing about the session or the
 * environment). Never with a proposal awaiting its reply, in a read-only session, after the harness
 * stopped the turn, after a Ctrl-C, past AUTO_CONTINUE_LIMIT, with the same reasons as the last
 * continue (no progress), with no turn left or when the next request could pass the spend cap.
 * `tell`: the owner hears why (the agent could have gone on but a bound stopped it).
 */
export function autoContinue(c: ContinueState): ContinueDecision {
  const no = (why: string, tell = false): ContinueDecision => ({ go: false, why, tell });
  if (c.status !== 'yielded') return no(`the turn ended ${c.status}`);
  if (c.interrupted) return no('the owner pressed Ctrl-C');
  if (c.pending) return no('a proposal awaits the owner\'s reply');
  if (!c.writable) return no('the session is read-only');
  if (c.stopped) return no('the harness ended the turn');
  const v = c.verdict;
  if (v === null || v.trigger !== 'turn') return no('the turn changed nothing the gates judged');
  if (v.kind !== 'NOT DONE') return no(`the verdict is ${v.kind}`);
  const failed = v.gates.filter((g) => g.status === 'fail');
  // reasons = the failed gates, then UNPROVEN gates and what is unproven about the session or the environment.
  if (failed.length === 0 || v.reasons.length !== failed.length) return no('the verdict has reasons the agent cannot act on (UNPROVEN, the session or the environment)');
  const other = failed.find((g) => !ACTIONABLE_GATES.has(g.gate));
  if (other !== undefined) return no(`gate ${other.gate} failed, which the agent does not fix by itself`);
  if (c.done >= AUTO_CONTINUE_LIMIT) return no(`the gates still say NOT DONE after ${AUTO_CONTINUE_LIMIT} automatic continues; back to you`, true);
  const key = v.reasons.join('\n');
  if (key === c.previous) return no('the gates give the same reasons as before the last continue (no progress); back to you', true);
  if (c.turnsLeft <= 0) return no('this message\'s turn budget is used up; back to you', true);
  if (c.spend !== null) return no(c.spend, true);
  return { go: true, key };
}

/** Detail lines a continue hands over per failed gate (what blocks; never the pre-existing ones). */
const CONTINUE_DETAILS = 10;

/** What the model is told when its message continues by itself: the verdict's reasons and what blocks. */
export function continueMessage(v: Pick<SessionVerdict, 'reasons' | 'gates'>, n: number): string {
  const lines = ['[harness] You ended your turn without calling finish, and the fresh run of every required gate says NOT DONE:'];
  for (const r of v.reasons) lines.push(`- ${clip(r, 600)}`);
  for (const g of v.gates.filter((x) => x.status === 'fail')) {
    const blocking = (g.details ?? []).filter((d) => !d.startsWith('pre-existing') && !d.startsWith('… '));
    if (blocking.length === 0) continue;
    lines.push(`gate ${g.gate}:`);
    for (const d of blocking.slice(0, CONTINUE_DETAILS)) lines.push(`  ${clip(d, 300)}`);
    if (blocking.length > CONTINUE_DETAILS) lines.push(`  … ${blocking.length - CONTINUE_DETAILS} more`);
  }
  lines.push(`Fix these and call finish, or tell the owner plainly why you cannot. (The harness continued this message by itself: ${n} of at most ${AUTO_CONTINUE_LIMIT}.)`);
  return lines.join('\n');
}

/** The same pre-tool refusal this many times within one owner message: the agent is stuck, and its turn ends. */
export const STUCK_REFUSALS = 4;

/** A hook's refusal of a tool call before it ran: which hook, the call's paths, and its reason as the hook gave it. */
export interface Refusal {
  hook: string;
  /** The call's paths, joined ("(no path)" when it had none). */
  path: string;
  reason: string;
}

/** The pre-tool refusal a recorded event is (a hook's block of a call, before it ran), else null. */
export function preToolRefusal(e: RunEvent): Refusal | null {
  if (e.kind !== 'hook' || e.decision !== 'block') return null;
  const data = e.data as { event?: unknown; paths?: unknown } | undefined;
  if (data?.event !== 'pre_tool') return null;
  const paths = Array.isArray(data.paths) ? data.paths.filter((p): p is string => typeof p === 'string') : [];
  const own = `${e.source}: `;
  return { hook: e.source, path: paths.length > 0 ? paths.join(', ') : '(no path)', reason: e.message.startsWith(own) ? e.message.slice(own.length) : e.message };
}

/**
 * Counts refusals per key: the same hook, the same path, the same reason text. A refusal for another
 * path or with another reason counts for its own key only, and resets nothing.
 */
export class RefusalCounter {
  private readonly counts = new Map<string, number>();

  /** Counts `r`; how many times this very refusal has happened now. */
  add(r: Refusal): number {
    const key = JSON.stringify([r.hook, r.path, r.reason]);
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }

  clear(): void {
    this.counts.clear();
  }
}

function firstLineOf(text: string): string {
  return text.split('\n')[0] ?? '';
}

/** Remove the run-start copies (initial/) of every session but the newest `keep` (and `current`). */
export function pruneSessionCopies(sessionsDir: string, current: string, keep: number = KEEP_SESSION_COPIES): string[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir).filter((n) => n !== current && existsSync(join(sessionsDir, n, 'initial')));
  } catch {
    return [];
  }
  const byAge = names.map((n) => ({ n, t: statSync(join(sessionsDir, n)).mtimeMs })).sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
  const removed: string[] = [];
  for (const { n } of byAge.slice(keep)) {
    rmSync(join(sessionsDir, n, 'initial'), { recursive: true, force: true });
    removed.push(n);
  }
  return removed;
}

export const HELP_LINES = [
  'Type to chat. The agent reads, explains and, after you approve its contract, changes this repository.',
  '  /status          branch, writability, item and stage, changed files, spend',
  '  /diff            the change in the working tree (new files included)',
  '  /cost            what this session has spent, against its cap',
  '  /gates           run every required gate now, fresh, and give the verdict',
  '  /model [id]      show the allowlisted models, or switch to one',
  '  /clear           start a new conversation (same session, item and records)',
  '  /ship            commit, push and open the PR (only after a DONE verdict)',
  '  /import <file>   propose a contract you wrote (<slug>.md, its .mjs Measure next to it)',
  '  /exit            end the session (also Ctrl-D, or Ctrl-C twice on an empty prompt)',
  'Ctrl-C cancels the agent\'s turn. After a proposal, the next message you type (other than a /command) is',
  'your reply: only a plain yes typed at this terminal approves it. Lines pasted together are one message.',
];

class Session {
  private pending: Pending | null = null;
  private lastVerdict: SessionVerdict | null = null;
  /** What the last verdict judged (at the start: the tree as the session found it). */
  private lastJudged: TreeFingerprint = {};
  private readonly verdicts: Array<Record<string, unknown>> = [];
  private readonly ships: Array<Record<string, unknown>> = [];
  private history: TranscriptTurn[] = [];
  private first: Message;
  private turns = 0;
  private turnRunning = false;
  /** Ctrl-C presses toward the exit (two on an empty prompt; one more after a busy Ctrl-C). */
  private interrupts = 0;
  /** A refusal the model cannot fix: its turn ends after the current tool turn. */
  private stop: string | null = null;
  /** Pre-tool refusals of the current owner message, per hook, path and reason (the stuck detector). */
  private readonly refusals = new RefusalCounter();
  /** The same refusal STUCK_REFUSALS times: the agent is stuck, and its turn ends after the current tool turn. */
  private stuck: (Refusal & { count: number }) | null = null;
  /** Files no gate judged when the session ended. */
  private unjudgedAtExit: string[] = [];
  /** Notes for the model, sent with the owner's next message. */
  private readonly harnessNotes: string[] = [];
  /** A commit /ship made for the bound item and could not push or open a PR for (why, and what a retry needs). */
  private committed: (ShipResume & { why: string }) | null = null;

  constructor(
    private readonly ui: Ui,
    private readonly input: OwnerInput,
    private readonly s: {
      cwd: string;
      top: string;
      repo: string;
      sid: string;
      stateDir: RepoStateDir;
      store: RunStore;
      ctx: RunContext;
      config: HarnessConfig;
      registry: RegistryView;
      writability: InPlaceVerdict;
      branch: string;
      baseSha: string;
      profile: TargetProfile | undefined;
      profileError: string | undefined;
      isolation: IsolationInfo;
      tools: ToolSpec[];
      system: string;
      files: string[];
      maxTurns: number;
      measureBaseline: (ctx: RunContext) => Promise<TestBaseline>;
      env: NodeJS.ProcessEnv;
      startedAt: string;
      lockNote: string | null;
      person: string;
      confined: ProposalEnv['confined'];
      startFingerprint: TreeFingerprint;
    },
    private driver: Driver,
    private meter: SpendMeter,
    private readonly ledger: TokenLedger,
  ) {
    this.first = this.opening();
    this.lastJudged = s.startFingerprint;
  }

  // ───────────── wiring ─────────────

  private opening(): Message {
    const s = this.s;
    return {
      role: 'user',
      parts: [{ type: 'text', text: sessionOpening({ repo: s.repo, top: s.top, branch: s.branch, baseSha: s.baseSha, writable: s.writability.writable, reason: s.writability.reason, stack: s.ctx.stack ?? 'unknown', files: s.files }) }],
    };
  }

  private get proposalEnv(): ProposalEnv {
    const s = this.s;
    return { top: s.top, itemsRoot: s.stateDir.itemsRoot, sessionId: s.sid, harnessRoot: HARNESS_ROOT, exec: s.ctx.exec, person: s.person, confined: s.confined };
  }

  /**
   * Run `fn` (something the harness does that must not be cut off: the gates, a measurement, /ship) with
   * a Ctrl-C handler that says so. A Ctrl-C there counts as the first of the two that exit.
   */
  private async guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
    const off = this.input.onInterrupt(() => {
      this.interrupts = 1;
      this.ui.note(`finishing ${what} first; Ctrl-C again after it ends to exit`);
    });
    try {
      return await fn();
    } finally {
      off();
    }
  }

  /** A refusal the model cannot fix: it is told to stop and report, and its turn ends after this tool turn. */
  private stopTurn(tool: string, reason: string): ToolResult {
    this.stop = reason;
    return { ok: false, summary: `${tool} refused: ${reason}. This is not something you can fix: do not retry it. Stop, tell the owner what is wrong and what they can do, and end your turn.` };
  }

  /** The slug of the proposal awaiting the owner's reply (null: none). */
  get pendingSlug(): string | null {
    return this.pending?.slug ?? null;
  }

  /** A failure the model cannot fix (environmentHook): its turn ends after this tool turn. */
  environmentStop(reason: string): void {
    this.stop ??= reason;
  }

  /**
   * Why a contract for `slug` would take over the bound item's work (null: no such problem): the bound
   * item is another one, and /ship committed it but could not push it or open its PR (that commit would
   * go out in the new item's PR), or the working tree holds changes that have not shipped. Checked when
   * a contract is proposed and again when the owner's yes would bind it.
   */
  private async takeOverProblem(slug: string): Promise<string | null> {
    const item = this.s.ctx.item;
    if (item === undefined || item.slug === slug) return null;
    const c = this.committed;
    if (c !== null && c.slug === item.slug) {
      const onBranch = await this.s.ctx.exec('git', ['-C', this.s.top, 'merge-base', '--is-ancestor', c.sha, 'HEAD'], { cwd: this.s.top, timeoutMs: 30_000 });
      if (onBranch.code === 0) {
        return `item ${item.slug} was committed (${c.sha.slice(0, 12)}) but not shipped (${c.why}): a contract for "${slug}" would carry that commit into its own pull request. The owner runs /ship again once that is fixed (it pushes ${item.slug}'s commit and opens its PR, committing nothing new), then "${slug}" can be proposed`;
      }
      // The owner took that commit off the branch: what is left of it, if anything, is in the tree.
      this.committed = null;
    }
    const changed = (await changedPaths(this.s.ctx, this.s.top)) ?? null;
    if (changed !== null && changed.length === 0) return null;
    const what = changed === null ? 'the working tree could not be read' : `${changed.length} changed file(s): ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', ...' : ''}`;
    return `item ${item.slug} is approved in this session and its changes have not shipped (${what}): a contract for "${slug}" would take that work over. The owner ships ${item.slug} first (/ship), or sets its changes aside, then "${slug}" can be proposed`;
  }

  /** The propose_contract tool's work (SessionPort.proposeContract): the harness writes and records it. */
  async proposeContract(input: unknown): Promise<ToolResult> {
    const w = this.s.writability;
    if (!w.writable) return this.stopTurn('propose_contract', `this session is read-only (${w.reason}; ${w.fix}): no contract can be proposed and no edit can happen in it`);
    if (this.pending !== null) return { ok: false, summary: `propose_contract refused: proposal ${this.pending.slug} already awaits the owner's reply. End your turn.` };
    const slug = typeof input === 'object' && input !== null && typeof (input as { slug?: unknown }).slug === 'string' ? (input as { slug: string }).slug : '';
    const taken = await this.takeOverProblem(slug);
    if (taken !== null) return this.stopTurn('propose_contract', taken);
    const r = await proposeDrafted(input, this.proposalEnv);
    if (!r.ok) {
      if (r.environment === true) return this.stopTurn('propose_contract', r.reason);
      return { ok: false, summary: `propose_contract refused: ${r.reason}. Fix it and call propose_contract again.` };
    }
    this.pending = { ...r.proposal, imported: false };
    this.s.ctx.emit({ kind: 'note', source: 'propose_contract', decision: 'record', message: `proposed ${r.proposal.slug} (ledger seq ${r.proposal.seq}, contract ${r.proposal.hash.slice(0, 12)}): awaiting the owner's typed reply`, data: { slug: r.proposal.slug, seq: r.proposal.seq, hash: r.proposal.hash } });
    const told = r.proposal.toModel.length > 0 ? ` Note: ${r.proposal.toModel.join('; ')}.` : '';
    return {
      ok: true,
      summary: `proposed ${r.proposal.slug} (contract ${r.proposal.hash.slice(0, 12)}): the owner has been shown it and must type their reply at the prompt.${told} End your turn now and wait; call no more tools.`,
      data: { slug: r.proposal.slug, seq: r.proposal.seq },
    };
  }

  /** Every recorded event, live: one line on screen; a passing write makes the last verdict stale. */
  onEvent(e: RunEvent): void {
    if (e.kind === 'tool' && e.decision === 'pass' && this.effectOf(e.source) === 'write') this.lastVerdict = null;
    if (e.kind === 'hook' && e.decision === 'block' && ENVIRONMENT_HOOKS.has(e.source)) this.stop ??= e.message.replace(new RegExp(`^${e.source}: `), '');
    const refused = preToolRefusal(e);
    if (refused !== null && this.turnRunning) {
      const count = this.refusals.add(refused);
      if (count >= STUCK_REFUSALS) this.stuck ??= { ...refused, count };
    }
    // Recorded for the evidence; the session prints these itself.
    if (e.kind === 'note' && (e.source === 'propose_contract' || e.source === 'takeover' || e.source === 'auto-continue' || e.source === 'stuck')) return;
    this.ui.event(e);
    if (this.turnRunning && (e.kind === 'tool' || e.kind === 'hook')) this.ui.startSpinner('working');
  }

  effectOf(tool: string): ToolEffect | undefined {
    return this.s.registry.tools.find((t) => t.plugin.name === tool)?.plugin.effect;
  }

  // ───────────── the REPL ─────────────

  async run(): Promise<void> {
    this.banner();
    for (;;) {
      const approval = this.pending !== null;
      // readline writes the prompt itself: rendered (the harness's colour only), never a painted string as it is.
      const prompt = this.ui.render(approval ? this.ui.paint('magenta', 'reply › ') : this.ui.paint('cyan', '› '));
      const l = await this.input.read(prompt, { approval });
      if (l.kind === 'eof') break;
      if (l.kind === 'interrupt') {
        this.interrupts += 1;
        if (this.interrupts >= 2) break;
        this.ui.note('(Ctrl-C again on an empty prompt to exit, or /exit)');
        continue;
      }
      this.interrupts = 0;
      const text = l.text.trim();
      if (text.length === 0) continue;
      if (this.input.channel === 'pipe') this.ui.line(this.ui.paint('dim', `${this.pending !== null ? 'reply › ' : '› '}${text}`));
      // A command is one line; a pasted message that starts with "/" is chat.
      if (text.startsWith('/') && !text.includes('\n')) {
        if ((await this.command(text)) === 'exit') break;
        continue;
      }
      if (this.pending !== null) {
        await this.reply(text);
        continue;
      }
      const notes = this.harnessNotes.splice(0);
      await this.turn(notes.length > 0 ? `${text}\n\n${notes.join('\n')}` : text);
    }
    await this.end();
  }

  private banner(): void {
    const s = this.s;
    this.ui.banner();
    this.ui.status({ repo: s.repo, branch: s.branch, writable: s.writability.writable, reason: s.writability.reason, fix: s.writability.fix, model: this.driver.model, capUsd: this.meter.capUsd });
    if (s.lockNote !== null) this.ui.note(s.lockNote);
    if (s.profile === undefined) this.ui.warn(`UNPROVEN: ${s.profileError ?? 'no target profile'} (a verdict here can never be DONE)`);
    else for (const u of s.profile.unsupported) this.ui.warn(`UNPROVEN: ${u}`);
    if (s.isolation.mechanism === 'none') this.ui.warn('UNPROVEN: no sandbox confines agent code here (tests cannot run confined; a verdict can never be DONE)');
    this.ui.note(`records ${tildePath(s.store.runDir)}  ·  /help for commands`);
  }

  /**
   * One owner message through the governed loop; a verdict after it when the tree changed. When the
   * model ended its turn without finish and that verdict is NOT DONE for reasons it can act on, the
   * harness hands it the reasons and it goes on with the same message, at most AUTO_CONTINUE_LIMIT times
   * (autoContinue says when never). The message's turn budget covers every continue.
   */
  private async turn(message: string): Promise<void> {
    const s = this.s;
    const controller = new AbortController();
    let used = 0;
    let continues = 0;
    let previous: string | null = null;
    let next = message;
    // The stuck detector counts within one owner message (its continues included).
    this.refusals.clear();
    for (;;) {
      const { result, stopped } = await this.agentTurn(next, controller, s.maxTurns - used);
      used += result.turns;
      // The gates judge every change: after an accepted finish, and after any turn that left the tree
      // different from what the last verdict judged (the model's words are never the verdict).
      let v: SessionVerdict | null = null;
      if (result.status === 'done') v = await this.verdict('finish');
      else if (await this.guarded('checking the working tree', () => this.treeMoved())) v = await this.verdict('turn');
      const told = v === null ? null : continueMessage(v, continues + 1);
      const d = autoContinue({
        status: result.status,
        verdict: v,
        pending: this.pending !== null,
        writable: s.writability.writable,
        stopped,
        interrupted: controller.signal.aborted || this.interrupts > 0,
        done: continues,
        previous,
        turnsLeft: s.maxTurns - used,
        spend: told === null ? null : this.meter.refuseNext(this.lastInputTokens() + Math.ceil(told.length / 4), s.ctx.task.limits.maxOutputTokens),
      });
      if (d.go && told !== null) {
        continues += 1;
        previous = d.key;
        this.ui.line(this.ui.paint('magenta', `↻ the gates said NOT DONE: the agent continues (${continues}/${AUTO_CONTINUE_LIMIT})`));
        s.ctx.emit({ kind: 'note', source: 'auto-continue', decision: 'record', message: `continue ${continues}/${AUTO_CONTINUE_LIMIT}: the turn verdict is NOT DONE for reasons the agent can act on; they were handed to it`, data: { reasons: v?.reasons ?? [] } });
        next = told;
        continue;
      }
      if (!d.go && d.tell) {
        this.ui.note(`↻ not continued: ${d.why}`);
        s.ctx.emit({ kind: 'note', source: 'auto-continue', decision: 'pass', message: `not continued: ${d.why}` });
      }
      // The model hears this verdict with the owner's next message (a continue already handed it over).
      if (v !== null && v.kind !== 'DONE') {
        this.harnessNotes.push(`[harness] After your ${v.trigger === 'finish' ? 'finish' : 'turn'}, the fresh run of every required gate says ${v.kind}: ${v.reasons.slice(0, 4).join('; ')}. The work is not complete; do not say it is.`);
      }
      break;
    }
    // A proposal is shown last: the next line typed answers it.
    if (this.pending !== null) this.showProposal(this.pending);
    this.writeRunJson('running');
  }

  /** The stuck refusal of the turn that just ended (null: none), cleared. */
  private takeStuck(): (Refusal & { count: number }) | null {
    const k = this.stuck;
    this.stuck = null;
    return k;
  }

  /** The input tokens of the last request sent (what the next one will be at least). */
  private lastInputTokens(): number {
    return this.ledger.report().turns.at(-1)?.actual_input_tokens ?? 0;
  }

  /**
   * The model's part of one owner message (or of a continue): the governed loop with `message`, at most
   * `maxTurns` turns, cancelled by Ctrl-C through `controller`. Says how it ended; `stopped` is true when
   * the harness ended it (a refusal the model cannot fix).
   */
  private async agentTurn(message: string, controller: AbortController, maxTurns: number): Promise<{ result: AgentResult; stopped: boolean }> {
    const s = this.s;
    const off = this.input.onInterrupt(() => controller.abort());
    this.turnRunning = true;
    this.stop = null;
    this.stuck = null;
    this.ui.startSpinner('thinking');
    let attempt = 1;
    let result: AgentResult;
    try {
      result = await runAgent({
        driver: this.driver,
        ctx: s.ctx,
        store: s.store,
        ledger: this.ledger,
        first: this.first,
        system: s.system,
        baselineSystem: s.system,
        tools: s.tools,
        maxTurns,
        maxOutputTokens: s.ctx.task.limits.maxOutputTokens,
        spend: { meter: this.meter, allowed: (m) => modelAllowed(s.config.models, m) },
        signal: controller.signal,
        history: this.history,
        message,
        yieldOnText: true,
        keepChat: true,
        skipShadowBaseline: true,
        yieldAfterTurn: () => this.pending !== null || this.stop !== null || this.stuck !== null,
        onText: (delta, info) => {
          if (info.attempt !== attempt) {
            attempt = info.attempt;
            this.ui.line(this.ui.paint('dim', '(that reply was cut off; retrying)'));
          }
          this.ui.write(delta);
        },
      });
    } finally {
      off();
      this.turnRunning = false;
      this.ui.stopSpinner();
      this.ui.endStream();
    }
    this.turns += result.turns;
    s.store.writeJson('state.json', serializeState(s.ctx.state));
    const k = this.takeStuck();
    const stopped = this.stop !== null || k !== null;
    if (this.stop !== null) {
      // The model was told in the tool result; the harness ends its turn and says it to the owner itself.
      this.ui.warn(`⏹ the agent stopped: ${clip(this.stop, 400)} (it cannot fix this; you can)`);
      this.harnessNotes.push(`[harness] Your last turn was ended by the harness: ${this.stop}. Nothing you can do with tools fixes this; do not retry it. Tell the owner what is wrong and what they can do.`);
      this.stop = null;
    }
    if (k !== null) {
      // The same refusal again and again: the owner decides what changes, not another retry.
      const why = clip(firstLineOf(k.reason), 300).replace(/[.\s]+$/, '');
      this.ui.warn(`⚠ the agent is stuck: ${k.hook} refused ${k.path} ${k.count} times: ${why}. Tell it what to do differently, or /exit.`);
      this.harnessNotes.push(`[harness] Your last turn was ended by the harness: ${k.hook} refused ${k.path} ${k.count} times with the same reason (${why}). Repeating that call cannot succeed: do not retry it. Read what the owner says next and do something different.`);
      s.ctx.emit({ kind: 'note', source: 'stuck', decision: 'block', message: `the agent is stuck: ${k.hook} refused ${k.path} ${k.count} times with the same reason; its turn was ended`, data: { hook: k.hook, path: k.path, reason: k.reason, count: k.count } });
    }
    switch (result.status) {
      case 'yielded':
      case 'done':
        break;
      case 'aborted':
        this.ui.warn('⏹ interrupted: the turn was cancelled. Back to you.');
        break;
      case 'max_turns':
        this.ui.warn(`⚠ the agent used its ${s.maxTurns} turns for this message without finishing. Say "continue" to let it go on.`);
        break;
      case 'spend_cap':
        this.ui.error(`✗ spend cap reached: ${result.error ?? ''}`);
        break;
      case 'model_refused':
        this.ui.error(`✗ ${result.error ?? 'the provider served a model that is not on the allowlist'}`);
        break;
      case 'refused':
        this.ui.warn('⚠ the model refused this request.');
        break;
      case 'stalled':
        this.ui.warn('⚠ the agent stalled without a tool call or a reply.');
        break;
      case 'error':
        this.ui.error(`✗ the turn failed: ${result.error ?? 'unknown error'}`);
        break;
    }
    return { result, stopped };
  }

  /** The changed paths and their content now, or null when git cannot tell. */
  private async fingerprintNow(): Promise<{ changed: string[]; fingerprint: TreeFingerprint } | null> {
    const changed = await changedPaths(this.s.ctx, this.s.top);
    if (changed === null) return null;
    const fingerprint = await treeFingerprint(this.s.ctx.exec, this.s.top, changed);
    return fingerprint === null ? null : { changed, fingerprint };
  }

  /** Whether the tree differs from what the last verdict judged (unknown counts as different). */
  private async treeMoved(): Promise<boolean> {
    const now = await this.fingerprintNow();
    return now === null || fingerprintDiff(this.lastJudged, now.fingerprint).length > 0;
  }

  private showProposal(p: Pending): void {
    this.ui.proposal(p.slug, p.text, p.notes, p.script);
  }

  /** The owner's reply to the proposal: the only line that reaches the ledger. */
  private async reply(text: string): Promise<void> {
    const s = this.s;
    const p = this.pending;
    if (p === null) return;
    this.pending = null;
    // A yes binds the new contract: checked again now, not only when it was proposed. The tree (or a
    // commit /ship could not push) may hold the bound item's work by now; a yes is then not recorded at all.
    if (classifyReply(text).kind === 'yes') {
      const taken = await this.guarded('checking the working tree', () => this.takeOverProblem(p.slug));
      if (taken !== null) {
        this.ui.error(`✗ not approved: ${taken}. Your reply was not recorded, and ${p.slug} is not bound.`);
        s.ctx.emit({ kind: 'note', source: 'takeover', decision: 'block', message: `the reply to proposal ${p.slug} was not recorded: ${taken}`, data: { slug: p.slug } });
        this.harnessNotes.push(`[harness] The owner replied to proposal ${p.slug} ("${clip(text, 80)}"), and the harness did not record or bind it: ${taken}. Nothing you can do with tools fixes this; do not retry it. Tell the owner, and propose ${p.slug} again only after they say ${s.ctx.item?.slug ?? 'the bound item'} has shipped.`);
        this.writeRunJson('running');
        return;
      }
    }
    const root = s.stateDir.itemsRoot;
    const { entry, verdict } = recordReply(root, p.slug, text, this.input.channel, s.sid);
    const approved = verdict.ok && verdict.turn?.seq === entry.seq;
    let note: string;
    if (approved) {
      this.ui.line(this.ui.paint(['green', 'bold'], `✔ approved: ${verdict.reason}`));
      s.ctx.item = { slug: p.slug, root, contractHash: p.hash };
      this.applyContract(p);
      await this.ensureBaseline();
      note = `[harness] The owner's reply above was recorded in the item ledger and APPROVED contract ${p.slug} (${p.hash.slice(0, 12)}). Edits under it are allowed now; build exactly what it says.`;
      const before = await this.guarded('the before reading', async () => {
        this.ui.startSpinner('reading the before value (the Measure script, confined and offline)');
        try {
          return await readBefore(this.proposalEnv, p.slug);
        } finally {
          this.ui.stopSpinner();
        }
      });
      if (before !== null) {
        if (before.ok) this.ui.note(before.owner);
        else this.ui.warn(`⚠ ${before.owner}`);
        note += `\n[harness] ${before.model}.`;
      }
    } else if (classifyReply(text).kind === 'no') {
      this.ui.warn(`✗ not approved: recorded as a decline. ${verdict.reason}`);
      note = `[harness] The owner's reply above did NOT approve contract ${p.slug}: it was recorded as a decline. Do not edit. Revise the contract as the owner asks and call propose_contract again.`;
    } else {
      this.ui.warn(`recorded, not an approval: ${verdict.reason}`);
      note = `[harness] The owner's reply above was recorded but is NOT an approval of contract ${p.slug} (${verdict.reason}). Do not edit. If they asked for changes, revise and call propose_contract again.`;
    }
    if (p.imported) note += `\n[harness] The contract was written by the owner (docs/contracts/${p.slug}.md):\n${p.text}`;
    this.writeRunJson('running');
    await this.turn(`${text}\n\n${note}`);
  }

  /** After approval: the task says what the contract says (ship text and gates read it), and so does the run's Base. */
  private applyContract(p: Pending): void {
    const task = this.s.ctx.task;
    const st = itemStatus(this.s.stateDir.itemsRoot, p.slug);
    const problem = (st.contract.parse?.fields.Problem ?? '').replace(/\s+/g, ' ').trim();
    if (task.kind === 'brownfield' && problem.length > 0) task.change = problem;
    task.title = (st.contract.parse?.fields.Commit ?? task.title).trim();
    this.s.ctx.run.baseBranch = p.base;
  }

  /** The repository's own suite, measured once, before the first write (lazily: only once an item is approved). */
  private async ensureBaseline(): Promise<void> {
    const ctx = this.s.ctx;
    if (ctx.state.testBaseline !== undefined) return;
    await this.guarded("the repository's own tests (the baseline)", async () => {
      this.ui.startSpinner("measuring the repository's own tests once (the baseline tests-green compares against)");
      try {
        ctx.state.testBaseline = await this.s.measureBaseline(ctx);
      } finally {
        this.ui.stopSpinner();
      }
    });
    if (ctx.state.testBaseline === undefined) return;
    const line = describeTestBaseline(ctx.state.testBaseline);
    ctx.emit({ kind: 'note', source: 'tests', message: line });
    this.s.store.writeJson('state.json', serializeState(ctx.state));
  }

  /** Every required gate, fresh, and the verdict from them (on what the tree held when they started). */
  private async verdict(trigger: VerdictTrigger): Promise<SessionVerdict> {
    const s = this.s;
    const v: SessionVerdict = await this.guarded('the gates', async () => {
      this.ui.quietGates = true;
      this.ui.startSpinner('running every required gate, fresh');
      try {
        const start = (await this.fingerprintNow()) ?? { changed: [], fingerprint: {} };
        const targetNotes = s.profile !== undefined ? s.profile.unsupported : [s.profileError ?? 'no target profile'];
        let out = await computeVerdict({ ctx: s.ctx, isolation: s.isolation, targetNotes, changed: start.changed, fingerprint: start.fingerprint, trigger });
        const end = await this.fingerprintNow();
        const moved = end === null ? ['(the working tree could not be read)'] : fingerprintDiff(start.fingerprint, end.fingerprint);
        if (moved.length > 0) out = movedVerdict(out, moved);
        return out;
      } finally {
        this.ui.stopSpinner();
        this.ui.quietGates = false;
      }
    });
    if (trigger === 'turn') this.ui.note('the turn changed the working tree: the gates judge it (the model\'s words never do)');
    this.ui.verdict(v);
    this.lastVerdict = v;
    this.lastJudged = v.fingerprint;
    this.verdicts.push(verdictRecord(v));
    s.store.writeJson('gates.json', { phase: 'finish', trigger, ok: v.gatesOk, results: v.gates });
    this.writeRunJson('running');
    return v;
  }

  // ───────────── commands ─────────────

  private async command(line: string): Promise<'exit' | void> {
    const [name = '', ...args] = line.slice(1).split(/\s+/).filter((x) => x.length > 0);
    switch (name) {
      case 'help':
        for (const l of HELP_LINES) this.ui.line(l);
        return;
      case 'exit':
      case 'quit':
        return 'exit';
      case 'status':
        await this.guarded('/status', () => this.status());
        return;
      case 'diff':
        await this.guarded('/diff', () => this.diff());
        return;
      case 'cost':
        this.cost();
        return;
      case 'gates':
        await this.verdict('gates');
        return;
      case 'model':
        this.model(args[0]);
        return;
      case 'clear':
        this.clear();
        return;
      case 'ship':
        await this.guarded('/ship', () => this.ship());
        return;
      case 'import':
        await this.guarded('/import', () => this.importContract(args.join(' ')));
        return;
      default:
        this.ui.warn(`unknown command /${name} (/help lists them)`);
    }
  }

  private async status(): Promise<void> {
    const s = this.s;
    const now = await branchVerdict(s.top, s.config, s.ctx.exec);
    const w = s.writability;
    this.ui.line(`repo     ${s.repo} (${tildePath(s.top)})`);
    this.ui.line(`branch   ${s.branch} ${w.writable ? '(writable)' : `(read-only: ${w.reason}; ${w.fix})`}${now.branch !== s.branch ? `  now on ${now.branch ?? 'a detached HEAD'}: writes are refused until you switch back` : ''}`);
    const item = s.ctx.item;
    if (item !== undefined) this.ui.line(`item     ${item.slug}  ${itemStatus(item.root, item.slug).stage}  (contract ${item.contractHash.slice(0, 12)})`);
    else if (this.pending !== null) this.ui.line(`item     ${this.pending.slug}  awaiting your reply (the next line you type)`);
    else this.ui.line('item     none yet: the agent proposes a contract before its first edit');
    const changed = (await changedPaths(s.ctx, s.top)) ?? [];
    this.ui.line(`changed  ${changed.length === 0 ? 'nothing' : `${changed.length} file(s): ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', ...' : ''}`}`);
    this.ui.line(`verdict  ${this.lastVerdict === null ? 'none current' : `${this.lastVerdict.kind} (${this.lastVerdict.trigger}, ${this.lastVerdict.at})`}`);
    this.ui.line(`model    ${this.driver.model}  ·  spend ${usd(this.meter.spentUsd)} of ${usd(this.meter.capUsd)}  ·  turns ${this.turns}`);
    this.ui.line(`records  ${tildePath(s.store.runDir)}`);
  }

  private async diff(): Promise<void> {
    const s = this.s;
    const git = (args: string[]): Promise<{ code: number | null; stdout: string }> => s.ctx.exec('git', ['-C', s.top, ...args], { cwd: s.top, timeoutMs: 60_000 });
    const tracked = await git(['diff', '--no-color', s.baseSha.length > 0 ? 'HEAD' : '--cached', '--']);
    const untracked = await git(['ls-files', '-z', '--others', '--exclude-standard']);
    let shown = false;
    if (tracked.code === 0 && tracked.stdout.trim().length > 0) {
      this.ui.diff(tracked.stdout);
      shown = true;
    }
    for (const rel of untracked.stdout.split('\u0000').filter((p) => p.length > 0).sort()) {
      shown = true;
      this.ui.line(this.ui.paint('bold', `new file ${rel}`));
      if (isEnvPath(rel)) {
        this.ui.note('  (an environment file: its content is never shown)');
        continue;
      }
      const content = await s.ctx.workspace.read(rel).catch(() => null);
      if (content === null || content.includes('\u0000')) {
        this.ui.note('  (binary or unreadable)');
        continue;
      }
      const lines = content.replace(/\n$/, '').split('\n');
      this.ui.diff(lines.slice(0, 200).map((l) => `+${l}`).join('\n'));
      if (lines.length > 200) this.ui.note(`  … ${lines.length - 200} more lines`);
    }
    if (!shown) this.ui.note('no changes in the working tree');
  }

  private cost(): void {
    const t = this.ledger.report().totals;
    this.ui.line(`spend    ${spendLine(this.meter)}`);
    this.ui.line(`tokens   ${t.actual_input_tokens} input counted over ${this.ledger.report().turns.length} request(s)  ·  turns ${this.turns}`);
  }

  private model(id: string | undefined): void {
    const s = this.s;
    if (id === undefined) {
      this.ui.line(`model    ${this.driver.model} (${this.driver.name})`);
      this.ui.line(`allowed  ${allowlistedModels(s.config.models).join(', ') || '(none)'}  (/model <id> switches)`);
      return;
    }
    const pick = pickModel({ model: id }, { plugins: s.registry.drivers.map((d) => d.plugin), policy: s.config.models, env: s.env, harnessRoot: HARNESS_ROOT });
    if (!pick.ok) {
      this.ui.error(`✗ ${pick.reason}`);
      return;
    }
    // One cap per session: the new meter starts from what the session has already spent.
    const meter = new SpendMeter(s.config.models.maxRunUsd, pick.price, normalizeModel(pick.driver.model));
    meter.spentUsd = this.meter.spentUsd;
    this.meter = meter;
    this.driver = pick.driver;
    s.ctx.run.model = pick.driver.model;
    s.ctx.run.driver = pick.driver.name;
    this.ui.line(`model    now ${pick.driver.model} (${pick.driver.name}); spent so far ${usd(meter.spentUsd)} of ${usd(meter.capUsd)}`);
    this.writeRunJson('running');
  }

  private clear(): void {
    this.history = [];
    this.first = this.opening();
    this.harnessNotes.length = 0;
    if (this.pending !== null) this.ui.note(`proposal ${this.pending.slug} dropped: the agent proposes again when it needs to`);
    this.pending = null;
    this.s.store.appendTranscript({ cleared: true, afterTurn: this.s.ctx.state.turn, at: new Date().toISOString() });
    this.ui.note('new conversation: same session, item, records and spend');
  }

  private async ship(): Promise<void> {
    const s = this.s;
    this.ledger.write(s.stateDir.tokensDir);
    // A commit an earlier /ship made for this item and could not push: this /ship pushes it, committing nothing.
    const item = s.ctx.item;
    const c = this.committed;
    const resume = c !== null && item !== undefined && c.slug === item.slug && c.contractHash === item.contractHash ? { slug: c.slug, contractHash: c.contractHash, sha: c.sha, title: c.title, body: c.body } : undefined;
    this.ui.startSpinner(resume !== undefined ? `pushing ${resume.sha.slice(0, 12)}, the commit the last /ship made, and opening its PR` : 'shipping: the ship gates run fresh first');
    let r: Awaited<ReturnType<typeof sessionShip>>;
    try {
      r = await sessionShip({
        ctx: s.ctx,
        top: s.top,
        sessionId: s.sid,
        lastVerdict: this.lastVerdict,
        stateRoot: s.stateDir.root,
        // No absolute local path in what is committed: the records are named relative to the state directory.
        summary: { model: this.driver.model, spend: { spentUsd: Number(this.meter.spentUsd.toFixed(6)), capUsd: this.meter.capUsd }, sessionRecords: `<state-dir>/sessions/${s.sid}` },
        ...(resume !== undefined ? { resume } : {}),
      });
    } finally {
      this.ui.stopSpinner();
    }
    if (r.status === 'shipped') this.committed = null;
    else if (r.status === 'committed' && r.retry !== undefined) this.committed = { ...r.retry, why: r.reasons[0] ?? 'not pushed' };
    const { retry: _retry, ...recorded } = r;
    this.ships.push({ at: new Date().toISOString(), ...recorded });
    if (r.status === 'refused') {
      this.ui.error(`✗ ship refused: ${r.reasons[0] ?? ''}`);
      for (const x of r.reasons.slice(1, 12)) this.ui.line(`  ${x}`);
    } else {
      const head = r.status === 'shipped' ? this.ui.paint(['green', 'bold'], '✔ shipped') : this.ui.paint('yellow', '● committed');
      this.ui.line(`${head} ${r.commit?.slice(0, 12) ?? ''} on ${r.branch}${r.prUrl !== undefined ? `  ${r.prUrl}` : ''}`);
      for (const x of r.reasons) this.ui.line(`  ${x}`);
      if (r.status === 'committed') this.ui.note('once that is fixed, /ship again pushes this commit and opens its PR (nothing is committed twice); until then no other item can be approved here');
      if (r.status === 'shipped') this.ui.note('after the merge: harness item close <slug> (in this repository) reads the metric again');
      this.ui.note('start a new session for the next change: this one\'s gates compare against the commit it started from');
      // What was committed is no longer a change: the next verdict starts from a clean tree.
      const now = await this.fingerprintNow();
      if (now !== null) this.lastJudged = now.fingerprint;
    }
    this.writeRunJson('running');
  }

  private async importContract(path: string): Promise<void> {
    const w = this.s.writability;
    if (path.length === 0) {
      this.ui.warn('usage: /import <path to <slug>.md>');
      return;
    }
    if (!w.writable) {
      this.ui.error(`✗ this session is read-only (${w.reason}; ${w.fix}): nothing can be proposed in it`);
      return;
    }
    if (this.pending !== null) {
      this.ui.warn(`proposal ${this.pending.slug} is waiting for your reply: answer it first`);
      return;
    }
    const taken = await this.takeOverProblem(basename(path).replace(/\.md$/i, ''));
    if (taken !== null) {
      this.ui.error(`✗ not proposed: ${taken}`);
      return;
    }
    this.ui.startSpinner('reading the contract and its metric');
    let r: Awaited<ReturnType<typeof proposeImported>>;
    try {
      r = await proposeImported(path, this.s.cwd, this.proposalEnv);
    } finally {
      this.ui.stopSpinner();
    }
    if (!r.ok) {
      this.ui.error(`✗ not proposed: ${r.reason}`);
      return;
    }
    this.pending = { ...r.proposal, imported: true };
    this.s.ctx.emit({ kind: 'note', source: 'import', decision: 'record', message: `owner imported and proposed ${r.proposal.slug} (ledger seq ${r.proposal.seq})` });
    this.showProposal(this.pending);
  }

  // ───────────── records ─────────────

  writeRunJson(status: 'running' | 'ended'): void {
    const s = this.s;
    const item = s.ctx.item;
    const st = item === undefined ? null : itemStatus(item.root, item.slug);
    s.store.writeJson('run.json', {
      kind: 'session',
      sessionId: s.sid,
      status,
      startedAt: s.startedAt,
      ...(status === 'ended' ? { endedAt: new Date().toISOString(), unjudgedAtExit: this.unjudgedAtExit } : {}),
      repoTop: s.top,
      repo: s.repo,
      branch: s.branch,
      // The PR's target: the approved contract's Base (none before a contract), never the working branch.
      baseBranch: st === null ? null : (st.contract.parse?.fields.Base ?? '').trim() || null,
      baseSha: s.baseSha,
      writable: s.writability.writable,
      ...(s.writability.writable ? {} : { readOnly: { reason: s.writability.reason, fix: s.writability.fix } }),
      driver: this.driver.name,
      model: this.driver.model,
      harnessRoot: HARNESS_ROOT,
      stateDir: s.stateDir.root,
      itemsRoot: s.stateDir.itemsRoot,
      task: { id: s.ctx.task.id, kind: s.ctx.task.kind, standards: s.ctx.task.kind === 'brownfield' ? s.ctx.task.standards : undefined },
      target: s.profile !== undefined ? profileRecord(s.profile) : { error: s.profileError ?? 'no profile' },
      isolation: s.isolation,
      toolsOffered: s.tools.map((t) => t.name),
      turns: this.turns,
      item: item === undefined || st === null ? null : { slug: item.slug, contractHash: item.contractHash, stage: st.stage },
      verdicts: this.verdicts,
      lastVerdict: this.lastVerdict === null ? null : this.lastVerdict.kind,
      ships: this.ships,
      spend: { model: this.meter.model, spentUsd: Number(this.meter.spentUsd.toFixed(6)), capUsd: this.meter.capUsd, price: this.meter.price },
    });
  }

  /** Leaving: work no gate judged is named (UNPROVEN), then the records are closed. */
  private async end(): Promise<void> {
    const s = this.s;
    const now = await this.guarded('closing the session', () => this.fingerprintNow());
    this.unjudgedAtExit = now === null ? ['(the working tree could not be read)'] : now.changed.filter((p) => now.fingerprint[p] !== this.lastJudged[p]);
    if (this.unjudgedAtExit.length > 0) {
      const files = this.unjudgedAtExit;
      this.ui.warn(`? UNPROVEN: no gate has judged ${files.slice(0, 8).join(', ')}${files.length > 8 ? `, ... (${files.length} files)` : ''}: this work is not complete. Run /gates in a new session before you ship it.`);
    }
    s.store.writeJson('state.json', serializeState(s.ctx.state));
    try {
      this.ledger.write(s.stateDir.tokensDir);
    } catch {
      // the token report is evidence, not a reason to fail the exit
    }
    this.writeRunJson('ended');
    this.ui.note(`session ended. Records: ${tildePath(s.store.runDir)}`);
  }
}

/**
 * The tools a session offers the model. A read-only session offers none that writes (effect 'write')
 * or proposes a contract: nothing invites the model to try what the session would refuse, and a call
 * to one anyway is an unknown tool.
 */
export function sessionTools(registry: Pick<RegistryView, 'tools'>, writable: boolean): ToolSpec[] {
  const all = toolSpecs(registry.tools, 'brownfield', { session: true });
  if (writable) return all;
  const changes = new Set(registry.tools.filter((t) => t.plugin.effect === 'write' || t.plugin.name === 'propose_contract').map((t) => t.plugin.name));
  return all.filter((t) => !changes.has(t.name));
}

/** Whether a Measure the model writes may run here: only where the sandbox confines it. */
export function measureConfinement(isolation: IsolationInfo, env: NodeJS.ProcessEnv): ProposalEnv['confined'] {
  if (isolation.mode === 'off' || sandboxMode(env) === 'off' || sandboxMode() === 'off') {
    return { ok: false, why: 'the sandbox is off here (HARNESS_SANDBOX=off, or "sandbox": "off" in harness.config.json): turn it on, or propose without a Measure script (Measure: none)' };
  }
  if (isolation.mechanism === 'none') return { ok: false, why: `no sandbox works on this machine (${process.platform}): propose without a Measure script (Measure: none)` };
  return { ok: true };
}

/** Start a session in the repository around `deps.cwd`; resolves when the owner exits. Exit code 2 = could not start. */
export async function runSession(deps: SessionDeps): Promise<SessionResult> {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? coreExec;
  const tools = new Map<string, ToolEffect>();
  const ui = new Ui(deps.output, colorEnabled(deps.output.isTTY, env), (t) => tools.get(t));

  const topR = await exec('git', ['-C', deps.cwd, 'rev-parse', '--show-toplevel'], { cwd: deps.cwd, timeoutMs: 30_000 }).catch(() => null);
  if (topR === null || topR.code !== 0 || topR.stdout.trim().length === 0) {
    ui.line(`harness: ${deps.cwd} is not inside a git repository. cd into a repository (or git init and commit one) and run harness again; harness --help shows the file-mode commands.`);
    return { code: 2 };
  }
  const top = realpathSync(topR.stdout.trim());

  const config0 = deps.config ?? loadConfig(HARNESS_ROOT);
  setSandboxMode(config0.sandbox);
  let registry: RegistryView;
  try {
    registry = deps.registry ?? (await loadRegistryOrThrow(config0));
  } catch (e) {
    ui.error(`harness: ${errMsg(e)}`);
    return { code: 2 };
  }
  for (const t of registry.tools) tools.set(t.plugin.name, t.plugin.effect);
  const missing = [
    ...missingRequiredHooks(registry.hooks, { inPlace: true }),
    ...SESSION_REQUIRED_HOOKS.filter((h) => !registry.hooks.some((r) => r.plugin.name === h)),
  ];
  if (missing.length > 0) {
    ui.error(`harness: refused: required hook(s) ${missing.join(', ')} are not registered (disabled in harness.config.json or failed to load), so nothing would stop an edit without an approved contract, on another branch, or to a git-ignored or .env* file`);
    return { code: 2 };
  }

  let driver: Driver;
  if (deps.driver !== undefined) driver = deps.driver;
  else {
    const pick = pickModel(deps.model ?? {}, { plugins: registry.drivers.map((d) => d.plugin), policy: config0.models, env, harnessRoot: HARNESS_ROOT });
    if (!pick.ok) {
      ui.error(`harness: ${pick.reason}`);
      return { code: 2 };
    }
    driver = pick.driver;
  }
  const policy = modelPolicyVerdict(config0.models, driver.name, driver.model);
  if (!policy.ok) {
    ui.error(`harness: refused before the first model turn (no tokens spent): ${policy.reason}`);
    return { code: 2 };
  }

  const stateDir = await repoStateDir(top, env, exec);
  const lock = acquireCheckoutLock(stateDir.locksDir, top);
  if (!lock.ok) {
    ui.error(`harness: ${lock.reason}`);
    return { code: 2 };
  }
  try {
    setConfinedRoot(top);
  } catch (e) {
    lock.release();
    ui.error(`harness: refused: ${errMsg(e)} (run harness inside a project repository)`);
    return { code: 2 };
  }
  let started = false;
  try {
    const sid = deps.sessionId ?? newSessionId();
    const runDir = join(stateDir.sessionsDir, sid);
    const store = new RunStore(runDir, HARNESS_ROOT);
    // Sessions keep their evidence in the state directory (ship's token line reads tokensDir).
    const config: HarnessConfig = { ...config0, runsDir: stateDir.sessionsDir, tokensDir: stateDir.tokensDir };
    const startedAt = new Date().toISOString();
    ui.startSpinner('reading the repository');
    const writability = await inPlaceWritability(top, config, exec);
    const head = await exec('git', ['-C', top, 'rev-parse', '--verify', '-q', 'HEAD'], { cwd: top, timeoutMs: 30_000 });
    const baseSha = head.code === 0 ? head.stdout.trim() : '';
    let branch = writability.branch;
    if (branch === null) {
      const sym = await exec('git', ['-C', top, 'symbolic-ref', '-q', '--short', 'HEAD'], { cwd: top, timeoutMs: 30_000 });
      branch = sym.code === 0 && sym.stdout.trim().length > 0 ? sym.stdout.trim() : 'HEAD';
    }
    const ws = createWorkspace(top, '.', { visibility: 'git' });
    const task = sessionTask(sid);
    // The profile of the owner's checkout, in place: the generic web stack and JavaScript test dirs apply.
    const target = await targetProfile(ws, { inPlace: true });
    if (target.profile !== undefined && task.kind === 'brownfield') task.scope = { allow: defaultScopeAllow(target.profile), deny: task.scope.deny };
    const state = newRunState();
    const files = await ws.list(['**/*']);
    state.initialHashes = await startHashes(ws, files);
    pruneSessionCopies(stateDir.sessionsDir, sid);
    const startChanged = await changedPaths({ exec }, top);
    const startFingerprint = (startChanged !== null ? await treeFingerprint(exec, top, startChanged) : null) ?? {};
    const isolation = deps.isolation ?? isolationInfo();
    const person = await personName({ top, exec }, deps.osUser ?? (() => {
      try {
        return userInfo().username;
      } catch {
        return env['USER'] ?? '';
      }
    }));
    let session: Session | null = null;
    const port = {
      id: sid,
      proposeContract: (input: unknown): Promise<ToolResult> => (session === null ? Promise.resolve({ ok: false, summary: 'the session is not ready' }) : session.proposeContract(input)),
    };
    const ctx = buildContext({
      // baseBranch: the PR's target is the approved contract's Base (set on approval), never the working branch.
      run: { id: sid, driver: driver.name, model: driver.model, startedAt, harnessRoot: HARNESS_ROOT, runDir, branch, baseBranch: '', baseSha },
      task,
      ws,
      state,
      store,
      mode: JIT_MODE,
      config,
      // The registered hooks, then no write while a proposal awaits its reply, then the session's lazy
      // run-start copy (only for a write every hook passed).
      registry: {
        ...registry,
        hooks: [
          ...registry.hooks,
          pendingProposalHook(() => session?.pendingSlug ?? null),
          initialCopyHook({ runDir, top, baseSha, exec, state: () => state }),
          // A run_tests failure the environment caused ends the model's turn (post_tool, run_tests only).
          environmentHook((why) => session?.environmentStop(why)),
        ],
      },
      exec,
      inPlace: { repoTop: top, branch },
      session: port,
      onEvent: (e) => session?.onEvent(e),
      ...(target.profile !== undefined ? { profile: target.profile } : {}),
    });
    const offered = sessionTools(registry, writability.writable);
    const checks = selectChecks(registry.checks.map((r) => r.plugin), undefined, undefined, ctx.stack);
    const repo = basename(top);
    const runner = target.profile !== undefined ? (target.profile.runner.supported ? target.profile.runner.name : `none supported: ${target.profile.runner.reason ?? target.profile.runner.name}`) : 'unknown';
    const system = sessionSystemPrompt({ repo, branch, writable: writability.writable, reason: writability.reason, stack: ctx.stack ?? 'unknown', runner, tools: offered, checks, checkOptions: config.checkOptions });
    const meter = new SpendMeter(config.models.maxRunUsd, policy.price, normalizeModel(driver.model));
    const ledger = new TokenLedger({ runId: sid, task: task.id, driver: driver.name, model: driver.model, counter: driver.tokenCounter, mode: 'jit' });
    ui.stopSpinner();
    session = new Session(
      ui,
      deps.input,
      {
        cwd: deps.cwd,
        top,
        repo,
        sid,
        stateDir,
        store,
        ctx,
        config,
        registry,
        writability,
        branch,
        baseSha,
        profile: target.profile,
        profileError: target.error,
        isolation,
        tools: offered,
        system,
        files,
        maxTurns: deps.maxTurns ?? DEFAULT_TURNS_PER_MESSAGE,
        measureBaseline: deps.measureBaseline ?? ((c) => measureTestBaseline({ root: c.workspace.root, exec: c.exec, harnessRoot: HARNESS_ROOT, logs: c.logs })),
        env,
        startedAt,
        lockNote: lock.tookOver !== undefined ? `took over a stale session lock (pid ${lock.tookOver.pid} is gone)` : null,
        person,
        confined: measureConfinement(isolation, env),
        startFingerprint,
      },
      driver,
      meter,
      ledger,
    );
    session.writeRunJson('running');
    started = true;
    await session.run();
    return { code: 0, sessionId: sid, sessionDir: runDir };
  } catch (e) {
    ui.stopSpinner();
    ui.error(`harness: ${started ? 'the session stopped' : 'the session could not start'}: ${errMsg(e)}`);
    return { code: 1 };
  } finally {
    setConfinedRoot(null);
    lock.release();
  }
}
