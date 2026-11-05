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
 *   - a line starting with "/" is a command, typed by the owner only (the model has no tool for any);
 *   - the ONE line typed right after a proposal is shown is the reply to it: it goes to recordReply with
 *     the input's own channel ('tty' only when typed at a terminal), and only it can approve;
 *   - Ctrl-C cancels the running turn; Ctrl-C twice on an empty prompt, or Ctrl-D, ends the session.
 * Until a contract is approved every edit is refused (problem-gate, contract-gate: no item is bound).
 * When the model's finish is accepted, every required gate runs again, fresh, and the verdict comes from
 * them, never from the model's words. The session never commits or pushes; /ship does, when typed.
 */
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { selectChecks } from '../core/checks.ts';
import { HARNESS_ROOT, loadConfig } from '../core/config.ts';
import { exec as coreExec } from '../core/exec.ts';
import { missingRequiredHooks } from '../core/hooks.ts';
import { inPlaceWritability, branchVerdict, type InPlaceVerdict } from '../core/inplace.ts';
import { classifyReply, itemStatus, recordReply } from '../core/items.ts';
import { runAgent, type AgentResult } from '../core/loop.ts';
import { toolSpecs } from '../core/registry.ts';
import { buildContext, JIT_MODE, loadRegistryOrThrow, preflight, snapshotHashes } from '../core/run.ts';
import { newRunState, RunStore, serializeState } from '../core/run-store.ts';
import { isolationInfo, setConfinedRoot, setSandboxMode, type IsolationInfo } from '../core/sandbox.ts';
import { modelAllowed, modelPolicyVerdict, normalizeModel, SpendMeter, spendLine, usd } from '../core/spend.ts';
import { acquireCheckoutLock, repoStateDir, type RepoStateDir } from '../core/state-home.ts';
import { profileRecord, type TargetProfile } from '../core/target.ts';
import { parseTask } from '../core/task.ts';
import { describeTestBaseline, measureTestBaseline } from '../core/test-baseline.ts';
import { TokenLedger } from '../core/tokens.ts';
import type { TranscriptTurn } from '../core/context.ts';
import type { Driver, Exec, HarnessConfig, Message, RegistryView, RunContext, RunEvent, Task, TestBaseline, ToolEffect, ToolResult, ToolSpec } from '../core/types.ts';
import { createWorkspace, isEnvPath } from '../core/workspace.ts';
import { proposeDrafted, proposeImported, type Proposal, type ProposalEnv } from './contract.ts';
import type { OwnerInput } from './input.ts';
import { allowlistedModels, pickModel, type ModelRequest } from './models.ts';
import { sessionOpening, sessionSystemPrompt } from './prompt.ts';
import { changedPaths, sessionShip } from './ship.ts';
import { colorEnabled, Ui, type Output } from './ui.ts';
import { computeVerdict, verdictRecord, type SessionVerdict } from './verdict.ts';

/** Turns the model may take for one owner message before the prompt comes back. */
export const DEFAULT_TURNS_PER_MESSAGE = 40;
/** A session's changed-lines budget (the diff-budget gate): generous, still reviewable. */
export const SESSION_MAX_DIFF_LINES = 800;

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
  'Ctrl-C cancels the agent\'s turn. After a proposal, the next line you type is your reply: only "yes"-style',
  'replies typed at this terminal approve it.',
];

class Session {
  private pending: Pending | null = null;
  private lastVerdict: SessionVerdict | null = null;
  private readonly verdicts: Array<Record<string, unknown>> = [];
  private readonly ships: Array<Record<string, unknown>> = [];
  private history: TranscriptTurn[] = [];
  private first: Message;
  private turns = 0;
  private turnRunning = false;
  /** Notes for the model, sent with the owner's next message. */
  private readonly harnessNotes: string[] = [];

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
    },
    private driver: Driver,
    private meter: SpendMeter,
    private readonly ledger: TokenLedger,
  ) {
    this.first = this.opening();
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
    return { top: this.s.top, itemsRoot: this.s.stateDir.itemsRoot, sessionId: this.s.sid, harnessRoot: HARNESS_ROOT, exec: this.s.ctx.exec, baseSha: this.s.baseSha };
  }

  /** The propose_contract tool's work (SessionPort.proposeContract): the harness writes and records it. */
  async proposeContract(input: unknown): Promise<ToolResult> {
    const w = this.s.writability;
    if (!w.writable) return { ok: false, summary: `propose_contract refused: this session is read-only (${w.reason}; ${w.fix}). No edit can happen in it: tell the owner.` };
    if (this.pending !== null) return { ok: false, summary: `propose_contract refused: proposal ${this.pending.slug} already awaits the owner's reply. End your turn.` };
    const r = await proposeDrafted(input, this.proposalEnv);
    if (!r.ok) return { ok: false, summary: `propose_contract refused: ${r.reason}. Fix it and call propose_contract again.` };
    this.pending = { ...r.proposal, imported: false };
    this.s.ctx.emit({ kind: 'note', source: 'propose_contract', decision: 'record', message: `proposed ${r.proposal.slug} (ledger seq ${r.proposal.seq}, contract ${r.proposal.hash.slice(0, 12)}): awaiting the owner's typed reply`, data: { slug: r.proposal.slug, seq: r.proposal.seq, hash: r.proposal.hash } });
    return {
      ok: true,
      summary: `proposed ${r.proposal.slug} (contract ${r.proposal.hash.slice(0, 12)}): the owner has been shown it and must type their reply at the prompt. End your turn now and wait; call no more tools.`,
      data: { slug: r.proposal.slug, seq: r.proposal.seq },
    };
  }

  /** Every recorded event, live: one line on screen; a passing write makes the last verdict stale. */
  onEvent(e: RunEvent): void {
    if (e.kind === 'tool' && e.decision === 'pass' && this.effectOf(e.source) === 'write') this.lastVerdict = null;
    if (e.kind === 'note' && e.source === 'propose_contract') return;
    this.ui.event(e);
    if (this.turnRunning && (e.kind === 'tool' || e.kind === 'hook')) this.ui.startSpinner('working');
  }

  effectOf(tool: string): ToolEffect | undefined {
    return this.s.registry.tools.find((t) => t.plugin.name === tool)?.plugin.effect;
  }

  // ───────────── the REPL ─────────────

  async run(): Promise<void> {
    this.banner();
    let interrupts = 0;
    for (;;) {
      const prompt = this.pending !== null ? this.ui.paint('magenta', 'reply › ') : this.ui.paint('cyan', '› ');
      const l = await this.input.read(prompt);
      if (l.kind === 'eof') break;
      if (l.kind === 'interrupt') {
        interrupts += 1;
        if (interrupts >= 2) break;
        this.ui.note('(Ctrl-C again on an empty prompt to exit, or /exit)');
        continue;
      }
      interrupts = 0;
      const text = l.text.trim();
      if (text.length === 0) continue;
      if (text.startsWith('/')) {
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
    this.end();
  }

  private banner(): void {
    const s = this.s;
    this.ui.banner();
    this.ui.status({ repo: s.repo, branch: s.branch, writable: s.writability.writable, reason: s.writability.reason, fix: s.writability.fix, model: this.driver.model, capUsd: this.meter.capUsd });
    if (s.lockNote !== null) this.ui.note(s.lockNote);
    if (s.profile === undefined) this.ui.warn(`UNPROVEN: ${s.profileError ?? 'no target profile'} (a verdict here can never be DONE)`);
    else for (const u of s.profile.unsupported) this.ui.warn(`UNPROVEN: ${u}`);
    if (s.isolation.mechanism === 'none') this.ui.warn('UNPROVEN: no sandbox confines agent code here (tests cannot run confined; a verdict can never be DONE)');
    this.ui.note(`records ${s.store.runDir}  ·  /help for commands`);
  }

  /** One owner message through the governed loop. */
  private async turn(message: string): Promise<void> {
    const s = this.s;
    const controller = new AbortController();
    const off = this.input.onInterrupt(() => controller.abort());
    this.turnRunning = true;
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
        maxTurns: s.maxTurns,
        maxOutputTokens: s.ctx.task.limits.maxOutputTokens,
        spend: { meter: this.meter, allowed: (m) => modelAllowed(s.config.models, m) },
        signal: controller.signal,
        history: this.history,
        message,
        yieldOnText: true,
        keepChat: true,
        skipShadowBaseline: true,
        yieldAfterTurn: () => this.pending !== null,
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
    if (this.pending !== null) this.showProposal(this.pending);
    switch (result.status) {
      case 'yielded':
        break;
      case 'done':
        await this.verdict('finish');
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
    this.writeRunJson('running');
  }

  private showProposal(p: Pending): void {
    this.ui.proposal(p.slug, p.text, p.notes);
  }

  /** The owner's reply to the proposal: the only line that reaches the ledger. */
  private async reply(text: string): Promise<void> {
    const s = this.s;
    const p = this.pending;
    if (p === null) return;
    this.pending = null;
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

  /** After approval: the task says what the contract says (ship text and gates read it). */
  private applyContract(p: Pending): void {
    const task = this.s.ctx.task;
    const st = itemStatus(this.s.stateDir.itemsRoot, p.slug);
    const problem = (st.contract.parse?.fields.Problem ?? '').replace(/\s+/g, ' ').trim();
    if (task.kind === 'brownfield' && problem.length > 0) task.change = problem;
    task.title = (st.contract.parse?.fields.Commit ?? task.title).trim();
  }

  /** The repository's own suite, measured once, before the first write (lazily: only once an item is approved). */
  private async ensureBaseline(): Promise<void> {
    const ctx = this.s.ctx;
    if (ctx.state.testBaseline !== undefined) return;
    this.ui.startSpinner("measuring the repository's own tests once (the baseline tests-green compares against)");
    try {
      ctx.state.testBaseline = await this.s.measureBaseline(ctx);
    } finally {
      this.ui.stopSpinner();
    }
    const line = describeTestBaseline(ctx.state.testBaseline);
    ctx.emit({ kind: 'note', source: 'tests', message: line });
    this.s.store.writeJson('state.json', serializeState(ctx.state));
  }

  /** Every required gate, fresh, and the verdict from them. */
  private async verdict(trigger: 'finish' | 'gates'): Promise<SessionVerdict> {
    const s = this.s;
    this.ui.quietGates = true;
    const off = this.input.onInterrupt(() => this.ui.note('(the gates are running; they finish first)'));
    this.ui.startSpinner('running every required gate, fresh');
    let v: SessionVerdict;
    try {
      const changed = (await changedPaths(s.ctx, s.top)) ?? [];
      const targetNotes = s.profile !== undefined ? s.profile.unsupported : [s.profileError ?? 'no target profile'];
      v = await computeVerdict({ ctx: s.ctx, isolation: s.isolation, targetNotes, changed, trigger });
    } finally {
      off();
      this.ui.stopSpinner();
      this.ui.quietGates = false;
    }
    this.ui.verdict(v);
    this.lastVerdict = v;
    this.verdicts.push(verdictRecord(v));
    s.store.writeJson('gates.json', { phase: 'finish', trigger, ok: v.gatesOk, results: v.gates });
    if (v.kind !== 'DONE' && trigger === 'finish') {
      this.harnessNotes.push(`[harness] After your finish, the fresh run of every required gate says ${v.kind}: ${v.reasons.slice(0, 4).join('; ')}. The work is not complete; do not say it is.`);
    }
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
        await this.status();
        return;
      case 'diff':
        await this.diff();
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
        await this.ship();
        return;
      case 'import':
        await this.importContract(args.join(' '));
        return;
      default:
        this.ui.warn(`unknown command /${name} (/help lists them)`);
    }
  }

  private async status(): Promise<void> {
    const s = this.s;
    const now = await branchVerdict(s.top, s.config, s.ctx.exec);
    const w = s.writability;
    this.ui.line(`repo     ${s.repo} (${s.top})`);
    this.ui.line(`branch   ${s.branch} ${w.writable ? '(writable)' : `(read-only: ${w.reason}; ${w.fix})`}${now.branch !== s.branch ? `  now on ${now.branch ?? 'a detached HEAD'}: writes are refused until you switch back` : ''}`);
    const item = s.ctx.item;
    if (item !== undefined) this.ui.line(`item     ${item.slug}  ${itemStatus(item.root, item.slug).stage}  (contract ${item.contractHash.slice(0, 12)})`);
    else if (this.pending !== null) this.ui.line(`item     ${this.pending.slug}  awaiting your reply (the next line you type)`);
    else this.ui.line('item     none yet: the agent proposes a contract before its first edit');
    const changed = (await changedPaths(s.ctx, s.top)) ?? [];
    this.ui.line(`changed  ${changed.length === 0 ? 'nothing' : `${changed.length} file(s): ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', ...' : ''}`}`);
    this.ui.line(`verdict  ${this.lastVerdict === null ? 'none current' : `${this.lastVerdict.kind} (${this.lastVerdict.trigger}, ${this.lastVerdict.at})`}`);
    this.ui.line(`model    ${this.driver.model}  ·  spend ${usd(this.meter.spentUsd)} of ${usd(this.meter.capUsd)}  ·  turns ${this.turns}`);
    this.ui.line(`records  ${s.store.runDir}`);
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
    this.ui.startSpinner('shipping: the ship gates run fresh first');
    let r: Awaited<ReturnType<typeof sessionShip>>;
    try {
      r = await sessionShip({
        ctx: s.ctx,
        top: s.top,
        sessionId: s.sid,
        lastVerdict: this.lastVerdict,
        summary: { model: this.driver.model, spend: { spentUsd: Number(this.meter.spentUsd.toFixed(6)), capUsd: this.meter.capUsd }, sessionRecords: s.store.runDir },
      });
    } finally {
      this.ui.stopSpinner();
    }
    this.ships.push({ at: new Date().toISOString(), ...r });
    if (r.status === 'refused') {
      this.ui.error(`✗ ship refused: ${r.reasons[0] ?? ''}`);
      for (const x of r.reasons.slice(1, 12)) this.ui.line(`  ${x}`);
    } else {
      const head = r.status === 'shipped' ? this.ui.paint(['green', 'bold'], '✔ shipped') : this.ui.paint('yellow', '● committed');
      this.ui.line(`${head} ${r.commit?.slice(0, 12) ?? ''} on ${r.branch}${r.prUrl !== undefined ? `  ${r.prUrl}` : ''}`);
      for (const x of r.reasons) this.ui.line(`  ${x}`);
      if (r.status === 'shipped') this.ui.note('after the merge: harness item close <slug> (in this repository) reads the metric again');
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
    s.store.writeJson('run.json', {
      kind: 'session',
      sessionId: s.sid,
      status,
      startedAt: s.startedAt,
      ...(status === 'ended' ? { endedAt: new Date().toISOString() } : {}),
      repoTop: s.top,
      repo: s.repo,
      branch: s.branch,
      baseBranch: s.branch,
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
      item: item === undefined ? null : { slug: item.slug, contractHash: item.contractHash, stage: itemStatus(item.root, item.slug).stage },
      verdicts: this.verdicts,
      lastVerdict: this.lastVerdict === null ? null : this.lastVerdict.kind,
      ships: this.ships,
      spend: { model: this.meter.model, spentUsd: Number(this.meter.spentUsd.toFixed(6)), capUsd: this.meter.capUsd, price: this.meter.price },
    });
  }

  private end(): void {
    const s = this.s;
    s.store.writeJson('state.json', serializeState(s.ctx.state));
    try {
      this.ledger.write(s.stateDir.tokensDir);
    } catch {
      // the token report is evidence, not a reason to fail the exit
    }
    this.writeRunJson('ended');
    this.ui.note(`session ended. Records: ${s.store.runDir}`);
  }
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
  const missing = missingRequiredHooks(registry.hooks, { inPlace: true });
  if (missing.length > 0) {
    ui.error(`harness: refused: required hook(s) ${missing.join(', ')} are not registered (disabled in harness.config.json or failed to load), so nothing would stop an edit without an approved contract or on another branch`);
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
    const target = await preflight(task, false, ws);
    const state = newRunState();
    state.initialHashes = await snapshotHashes(ws, runDir);
    const files = await ws.list(['**/*']);
    const isolation = deps.isolation ?? isolationInfo();
    let session: Session | null = null;
    const port = {
      id: sid,
      proposeContract: (input: unknown): Promise<ToolResult> => (session === null ? Promise.resolve({ ok: false, summary: 'the session is not ready' }) : session.proposeContract(input)),
    };
    const ctx = buildContext({
      run: { id: sid, driver: driver.name, model: driver.model, startedAt, harnessRoot: HARNESS_ROOT, runDir, branch, baseBranch: branch, baseSha },
      task,
      ws,
      state,
      store,
      mode: JIT_MODE,
      config,
      registry,
      exec,
      inPlace: { repoTop: top, branch },
      session: port,
      onEvent: (e) => session?.onEvent(e),
      ...(target.profile !== undefined ? { profile: target.profile } : {}),
    });
    const offered = toolSpecs(registry.tools, 'brownfield', { session: true });
    const checks = selectChecks(registry.checks.map((r) => r.plugin), undefined, undefined, ctx.stack);
    const repo = basename(top);
    const runner = target.profile !== undefined ? (target.profile.runner.supported ? target.profile.runner.name : `none supported: ${target.profile.runner.reason ?? target.profile.runner.name}`) : 'unknown';
    const system = sessionSystemPrompt({ repo, branch, writable: writability.writable, reason: writability.reason, stack: ctx.stack ?? 'unknown', runner, tools: offered, checks });
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
      },
      driver,
      meter,
      ledger,
    );
    session.writeRunJson('running');
    await session.run();
    return { code: 0, sessionId: sid, sessionDir: runDir };
  } finally {
    setConfinedRoot(null);
    lock.release();
  }
}
