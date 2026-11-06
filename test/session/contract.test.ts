/**
 * A session's contract: the harness writes it in the format the gates parse, fills Repo, Base and
 * Stakeholder, and proposes it; the Measure script the model drafted is only written and shown, and
 * runs (confined, offline, without the commit's .env* files) only after the owner's yes. Each
 * acceptance has its refusal:
 *   - "Measure: none" is an explicit choice (a placeholder is not); "local:<name>" is a Repo (a bare
 *     name is not); an incomplete contract is never written or proposed;
 *   - a Base resolves only as origin's branch or a local branch (a stash, a revision, an option never);
 *   - a field with a control character is refused (plain text is not); a Stakeholder the model sends is
 *     ignored (the person at this terminal is named);
 *   - a model-written Measure is refused where the sandbox is off (Measure: none is not);
 *   - a refused re-proposal leaves the files as they were (an accepted one replaces them);
 *   - a Measure's output never reaches a failure reason, the model's line or the ledger (its number does).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preconditions } from '../../src/core/close.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import { appendLedger, itemPaths, itemStatus, parseContract, readLedger, recordReply } from '../../src/core/items.ts';
import { envEntries, lastNumber, readMetric } from '../../src/core/measure.ts';
import { detectMechanism } from '../../src/core/sandbox.ts';
import type { Exec } from '../../src/core/types.ts';
import { baseRef, defaultBase, draftedContract, incompleteReason, personName, proposeDrafted, proposeImported, readBefore, readingFailureForModel, replaceFiles, repoField, repoSlugFromRemote, type ProposalEnv } from '../../src/session/contract.ts';
import { ProposeContractInput, type ProposeContractInputT } from '../../plugins/tools/propose_contract.ts';
import { git, proposal, webRepo, type WebRepo } from './helpers.ts';

let r: WebRepo;
let env: ProposalEnv;
beforeEach(() => {
  r = webRepo();
  env = { top: r.repo, itemsRoot: join(r.home, 'items-root'), sessionId: 'test', harnessRoot: HARNESS_ROOT, exec, person: 'Ada Owner', confined: { ok: true } };
});
afterEach(() => r.cleanup());

const input = (over: Record<string, unknown> = {}): ProposeContractInputT => proposal(over) as unknown as ProposeContractInputT;
const sandboxed = detectMechanism() !== 'none';
const COUNT_SRC = "import { readdirSync } from 'node:fs';\nconsole.log(JSON.stringify({ metric: 'src files', value: readdirSync('src').length }));\n";

/** The core exec, recording every command (to prove what did and did not run). */
function recording(seen: string[]): Exec {
  return (cmd, args, opts) => {
    seen.push([cmd, ...args].join(' '));
    return exec(cmd, args, opts);
  };
}

describe('Repo and Base, filled by the harness', () => {
  it('owner/name from every origin URL shape', () => {
    expect(repoSlugFromRemote('git@github.com:acme/web-app.git')).toBe('acme/web-app');
    expect(repoSlugFromRemote('https://github.com/acme/web-app')).toBe('acme/web-app');
    expect(repoSlugFromRemote('ssh://git@github.com/acme/web-app.git/')).toBe('acme/web-app');
    expect(repoSlugFromRemote('not a url')).toBeNull();
  });

  it('no origin: local:<directory>; with one: owner/name', async () => {
    expect(await repoField(env)).toBe('local:tiny-web');
    git(r.repo, 'remote', 'add', 'origin', 'git@github.com:acme/tiny-web.git');
    expect(await repoField(env)).toBe('acme/tiny-web');
  });

  it('Base: origin/HEAD first, then the upstream, then a local development/main/master branch', async () => {
    expect(await defaultBase(env)).toBe('development');
    git(r.repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    git(r.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    expect(await defaultBase(env)).toBe('trunk');
  });
});

describe('a Base resolves only as a branch (origin\'s, else a local one)', () => {
  it('refuses a stash, a revision, an option, a ref that is no branch, and a branch that does not exist', async () => {
    git(r.repo, 'stash', 'list');
    for (const [base, why] of [
      ['stash', /neither a branch of origin \(refs\/remotes\/origin\/stash\) nor a local branch/],
      ['HEAD~1', /is not a branch name/],
      ['-x', /starts with "-"/],
      ['--upload-pack=x', /starts with "-"/],
      ['HEAD', /is not a valid branch name|neither a branch of origin/],
      ['no-such-branch', /neither a branch of origin/],
      ['a..b', /is not a valid branch name/],
    ] as const) {
      const b = await baseRef(env, base);
      expect(b.ok, base).toBe(false);
      if (!b.ok) expect(b.reason, base).toMatch(why);
    }
  });

  it('twin: a local branch resolves through refs/heads, and origin\'s branch is preferred when it exists', async () => {
    const local = await baseRef(env, 'development');
    expect(local).toMatchObject({ ok: true, ref: 'refs/heads/development', short: 'development' });
    git(r.repo, 'update-ref', 'refs/remotes/origin/development', 'HEAD');
    expect(await baseRef(env, 'development')).toMatchObject({ ok: true, ref: 'refs/remotes/origin/development', short: 'origin/development' });
  });

  it('a proposal whose base is a stash or an option is refused, and nothing is written', async () => {
    for (const base of ['stash', '-x']) {
      const o = await proposeDrafted(input({ base }), env);
      expect(o.ok, base).toBe(false);
      expect(existsSync(itemPaths(env.itemsRoot, 'greeting-name').contract)).toBe(false);
    }
  });
});

describe('the contract text', () => {
  it('a drafted contract parses complete, Measure: none and local:<name> included', () => {
    const text = draftedContract(input(), { repo: 'local:tiny-web', base: 'development', measure: 'none' });
    const p = parseContract(text);
    expect(p.missing).toEqual([]);
    expect(p.problems).toEqual([]);
    expect(p.complete).toBe(true);
    expect(p.measure).toBeNull();
    expect(p.scenarios).toEqual([{ when: 'a visitor named Ada opens the page', then: 'the page says Hello, Ada' }]);
  });

  it('twins: a Measure placeholder is missing, a bare Repo is malformed (only "none" and local:<name> are accepted)', () => {
    const tbd = parseContract(draftedContract(input(), { repo: 'local:tiny-web', base: 'development', measure: 'TBD' }));
    expect(tbd.missing).toContain('Measure');
    const bare = parseContract(draftedContract(input(), { repo: 'tiny-web', base: 'development', measure: 'none' }));
    expect(bare.problems.join(' ')).toMatch(/Repo must be "<owner>\/<name>", or "local:<name>"/);
    expect(parseContract(draftedContract(input(), { repo: 'local:', base: 'development', measure: 'none' })).complete).toBe(false);
  });

  it('values are one line each: a newline in the model\'s text never starts another field', () => {
    const text = draftedContract(input({ problem: 'line one\nOwner: someone else' }), { repo: 'local:x', base: 'main', measure: 'none' });
    const p = parseContract(text);
    expect(p.fields.Owner).toBe('web team');
    expect(p.fields.Problem).toBe('line one Owner: someone else');
  });

  it('an incomplete contract says what is missing, and why angle brackets read as placeholders', () => {
    const text = draftedContract(input({ owner: 'TBD', problem: 'the <Greeting /> component ignores names' }), { repo: 'local:x', base: 'main', measure: 'none' });
    expect(incompleteReason(parseContract(text), text)).toMatch(/missing or placeholder: Problem, Owner.*angle brackets/);
  });

  it('a contract with a control character (an ESC sequence, a bidi override) is refused by the parser every gate uses; plain text is not', () => {
    const plain = draftedContract(input(), { repo: 'local:x', base: 'main', measure: 'none' });
    expect(parseContract(plain).complete).toBe(true);
    for (const bad of ['\u001b[2J', '\u202e', '\u0007', '\u009b31m']) {
      const p = parseContract(plain.replace('Problem: The greeting', `Problem: The${bad} greeting`));
      expect(p.complete, JSON.stringify(bad)).toBe(false);
      expect(p.problems.join(' ')).toMatch(/the contract contains control characters \(U\+[0-9A-F]{4}/);
    }
    // Tabs and Windows line endings are text.
    expect(parseContract(plain.replace(/\n/g, '\r\n').replace('Problem: The', 'Problem:\tThe')).complete).toBe(true);
  });
});

describe('the propose_contract input', () => {
  it('refuses a control character in any field, and in the Measure script (raw ESC); plain text and escapes written as text pass', () => {
    expect(ProposeContractInput.safeParse(proposal()).success).toBe(true);
    for (const over of [{ problem: 'red\u001b[31m text' }, { commit: 'fix(x): a\u202eb' }, { notIncluded: ['a\u0008b'] }, { scenarios: [{ when: 'x\ry', then: 'z' }] }, { measureScript: "console.log('\u001b[2J')\n" }]) {
      const res = ProposeContractInput.safeParse(proposal(over));
      expect(res.success, JSON.stringify(over)).toBe(false);
      expect(JSON.stringify(res.error?.issues)).toMatch(/control characters/);
    }
    expect(ProposeContractInput.safeParse(proposal({ measureScript: "const esc = '\\x1b';\n\tconsole.log(1);\r\n" })).success).toBe(true);
  });
});

describe('the Measure script the owner reads is the script node runs', () => {
  const CR = String.fromCharCode(0x0d);
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const ZWJ = String.fromCharCode(0x200d);
  const BOM = String.fromCharCode(0xfeff);
  const CYRILLIC_A = String.fromCharCode(0x0430);
  const shown1 = "console.log(JSON.stringify({ metric: 'm', value: 1 })); // prints 1, nothing else";
  const ran42 = "console.log(JSON.stringify({ metric: 'm', value: 42 }));";

  it('a drafted script with a line break node sees and a terminal does not (lone CR, U+2028, U+2029), an invisible character, or a look-alike letter is refused, naming the line', () => {
    for (const [what, script, why] of [
      ['lone CR', `${shown1}${CR}${ran42}\n`, /line 1 holds U\+000D, a line break for node that a terminal does not show/],
      ['U+2028', `${shown1}${LS}${ran42}\n`, /line 1 holds U\+2028/],
      ['U+2029', `const a = 1;\n${shown1}${PS}${ran42}\n`, /line 2 holds U\+2029/],
      ['zero-width joiner', `const value = 1; const val${ZWJ}ue = 42;\nconsole.log(val${ZWJ}ue);\n`, /line 1 holds U\+200D: control characters and invisible characters are refused/],
      ['byte order mark', `${BOM}console.log(1);\n`, /line 1 holds U\+FEFF/],
      ['look-alike letter', `const v${CYRILLIC_A}lue = 42;\nconsole.log(v${CYRILLIC_A}lue);\n`, /line 1 holds U\+0430: a Measure script you write is printable ASCII only/],
    ] as const) {
      const res = ProposeContractInput.safeParse(proposal({ measureScript: script }));
      expect(res.success, what).toBe(false);
      expect(JSON.stringify(res.error?.issues), what).toMatch(why);
    }
  });

  it('twin: plain newlines and Windows line endings pass, and what is written ends lines with plain newlines', async () => {
    const crlf = `${shown1}\r\n${ran42}\r\n`;
    expect(ProposeContractInput.safeParse(proposal({ measureScript: crlf })).success).toBe(true);
    const o = await proposeDrafted(input({ measureScript: crlf }), env);
    expect(o.ok, o.ok ? '' : o.reason).toBe(true);
    if (!o.ok) return;
    expect(o.proposal.script?.text).toBe(`${shown1}\n${ran42}\n`);
    expect(readFileSync(join(env.itemsRoot, 'metrics', 'greeting-name.mjs'), 'utf8')).toBe(`${shown1}\n${ran42}\n`);
  });

  it('/import holds the owner\'s script to the same rule (non-ASCII text in it is fine), and nothing is written when it is refused', async () => {
    const dir = join(r.base, 'drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hand-made.md'), draftedContract(input({ slug: 'hand-made' }), { repo: 'acme/tiny-web', base: 'development', measure: 'node metrics/hand.mjs' }));
    for (const bad of [`${shown1}${CR}${ran42}\n`, `${shown1}${LS}${ran42}\n`, `console.log(1);${ZWJ}\n`]) {
      writeFileSync(join(dir, 'hand.mjs'), bad);
      const o = await proposeImported(join(dir, 'hand-made.md'), r.base, env);
      expect(o.ok === false && o.reason).toMatch(/the Measure script .*hand\.mjs cannot be shown as it runs: line 1 holds U\+(000D|2028|200D)/);
      expect(existsSync(join(env.itemsRoot, 'metrics', 'hand.mjs'))).toBe(false);
    }
    writeFileSync(join(dir, 'hand.mjs'), "// counts the café's menus\r\nconsole.log(7);\r\n");
    const ok = await proposeImported(join(dir, 'hand-made.md'), r.base, env);
    expect(ok.ok, ok.ok ? '' : ok.reason).toBe(true);
    expect(readFileSync(join(env.itemsRoot, 'metrics', 'hand.mjs'), 'utf8')).toBe("// counts the café's menus\nconsole.log(7);\n");
  });
});

describe('Stakeholder and Owner, filled by the harness', () => {
  it('the person at this terminal is the Stakeholder; a Stakeholder the model sends is ignored, and the tool result says so', async () => {
    const o = await proposeDrafted(input({ stakeholder: 'Mallory', owner: '' }), env);
    expect(o.ok, o.ok ? '' : o.reason).toBe(true);
    if (!o.ok) return;
    const p = parseContract(o.proposal.text);
    expect(p.fields.Stakeholder).toBe('Ada Owner');
    expect(p.fields.Owner).toBe('Ada Owner');
    expect(o.proposal.toModel.join(' ')).toMatch(/the Stakeholder you sent \("Mallory"\) was ignored: the harness names the person at this terminal \(Ada Owner\)/);
    expect(readLedger(itemPaths(env.itemsRoot, 'greeting-name').ledger).entries[0]?.event).toMatchObject({ type: 'proposed', stakeholder: 'Ada Owner' });
  });

  it('twin: no Stakeholder sent, nothing to say; an Owner the model names is kept', async () => {
    const raw = proposal();
    delete raw['stakeholder'];
    const o = await proposeDrafted(raw, env);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.proposal.toModel).toEqual([]);
    expect(parseContract(o.proposal.text).fields).toMatchObject({ Stakeholder: 'Ada Owner', Owner: 'web team' });
  });

  it('the person: git config user.name in the repository, else the OS user name', async () => {
    expect(await personName(env, () => 'os-user')).toBe('Ada Owner');
    const noGit: Exec = async (cmd, args, opts) => (args.includes('config') ? { code: 1, stdout: '', stderr: '', durationMs: 0, timedOut: false } : exec(cmd, args, opts));
    expect(await personName({ top: r.repo, exec: noGit }, () => 'os-user')).toBe('os-user');
    expect(await personName({ top: r.repo, exec: noGit }, () => '')).toBe('the owner at this terminal');
  });
});

describe('proposeDrafted: nothing runs before the yes', () => {
  it('writes the contract outside the repository and records the proposal (Measure: none: no reading)', async () => {
    const o = await proposeDrafted(input(), env);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.proposal).toMatchObject({ slug: 'greeting-name', seq: 1, script: null, base: 'development' });
    expect(readLedger(itemPaths(env.itemsRoot, 'greeting-name').ledger).entries.map((e) => e.event.type)).toEqual(['proposed']);
    expect(existsSync(join(r.repo, 'docs'))).toBe(false);
    expect(git(r.repo, 'status', '--porcelain')).toBe('');
  });

  it('a drafted Measure script is written and shown in full, and NOT run: no reading, no before value', async () => {
    const seen: string[] = [];
    const o = await proposeDrafted(input({ measureScript: COUNT_SRC }), { ...env, exec: recording(seen) });
    expect(o.ok, o.ok ? '' : o.reason).toBe(true);
    if (!o.ok) return;
    expect(o.proposal.script).toEqual({ path: 'metrics/greeting-name.mjs', text: COUNT_SRC });
    expect(readFileSync(join(env.itemsRoot, 'metrics', 'greeting-name.mjs'), 'utf8')).toBe(COUNT_SRC);
    expect(parseContract(o.proposal.text).fields.Measure).toBe('node metrics/greeting-name.mjs');
    expect(o.proposal.text).toMatch(/before: ____ after: ____/);
    expect(o.proposal.notes.join('\n')).toMatch(/before value: read by the harness at development only after your yes/);
    // Nothing ran the script, and no worktree was made for it.
    expect(seen.filter((c) => c.startsWith(process.execPath) || / worktree add /.test(c))).toEqual([]);
    const ledger = readLedger(itemPaths(env.itemsRoot, 'greeting-name').ledger).entries;
    expect(ledger.map((e) => e.event.type)).toEqual(['proposed']);
    expect(ledger[0]?.event).toMatchObject({ type: 'proposed', before: null });
  });

  it('refuses an incomplete contract: nothing written, nothing proposed', async () => {
    const o = await proposeDrafted(input({ notIncluded: ['TBD'] }), env);
    expect(o).toMatchObject({ ok: false });
    if (!o.ok) expect(o.reason).toMatch(/Not included/);
    expect(existsSync(itemPaths(env.itemsRoot, 'greeting-name').contract)).toBe(false);
  });

  it('refuses invalid input and a bad slug', async () => {
    expect(await proposeDrafted({ slug: 'x' }, env)).toMatchObject({ ok: false });
    const o = await proposeDrafted(input({ slug: 'Not A Slug' }), env);
    expect(o.ok === false && o.reason).toMatch(/invalid slug/);
  });

  it('a model-written Measure is refused where the sandbox is off (an environment refusal), and nothing is written', async () => {
    const off = { ...env, confined: { ok: false as const, why: 'the sandbox is off here (HARNESS_SANDBOX=off)' } };
    const o = await proposeDrafted(input({ measureScript: COUNT_SRC }), off);
    expect(o).toMatchObject({ ok: false, environment: true });
    if (!o.ok) expect(o.reason).toMatch(/runs only where the sandbox confines it, and the sandbox is off here \(HARNESS_SANDBOX=off\)/);
    expect(existsSync(join(env.itemsRoot, 'metrics', 'greeting-name.mjs'))).toBe(false);
    // Twins: the same contract without a script (Measure: none) is proposed with the sandbox off; with it on, the script is.
    expect((await proposeDrafted(input(), off)).ok).toBe(true);
    expect((await proposeDrafted(input({ slug: 'with-script', measureScript: COUNT_SRC }), env)).ok).toBe(true);
  });

  it('a slug that already shipped is refused', async () => {
    const o = await proposeDrafted(input(), env);
    expect(o.ok).toBe(true);
    recordReply(env.itemsRoot, 'greeting-name', 'yes', 'tty', 'test');
    appendLedger(itemPaths(env.itemsRoot, 'greeting-name').ledger, { type: 'shipped', runId: 's', branch: 'fix/x', headSha: 'abc', base: 'development', prUrl: 'https://example.test/pr/1' });
    expect(itemStatus(env.itemsRoot, 'greeting-name').stage).toBe('shipped');
    const again = await proposeDrafted(input(), env);
    expect(again.ok === false && again.reason).toMatch(/is shipped .*choose another slug/);
  });

  it('an item with Measure: none can be approved, but can never close (no before reading)', async () => {
    expect((await proposeDrafted(input(), env)).ok).toBe(true);
    recordReply(env.itemsRoot, 'greeting-name', 'yes', 'tty', 'test');
    const ledger = itemPaths(env.itemsRoot, 'greeting-name').ledger;
    appendLedger(ledger, { type: 'shipped', runId: 's', branch: 'fix/x', headSha: 'abc', base: 'development', prUrl: 'https://example.test/pr/1' });
    const status = itemStatus(env.itemsRoot, 'greeting-name');
    expect(status.editable).toBe(true);
    const shipped = status.ledger.entries.find((e) => e.event.type === 'shipped');
    const reasons = preconditions({ status, shipped: shipped !== undefined && shipped.event.type === 'shipped' ? { entry: shipped, event: shipped.event } : null, before: null });
    expect(reasons.join(' ')).toMatch(/no Measure: the outcome cannot be read/);
  });
});

describe('a refused re-proposal changes nothing', () => {
  const V2 = "console.log('2');\n";

  it('a commitlint that cannot run refuses the edited contract (environment): the contract and the script stay as proposed', async () => {
    expect((await proposeDrafted(input({ measureScript: COUNT_SRC }), env)).ok).toBe(true);
    const paths = itemPaths(env.itemsRoot, 'greeting-name');
    const before = { contract: readFileSync(paths.contract, 'utf8'), script: readFileSync(join(env.itemsRoot, 'metrics', 'greeting-name.mjs'), 'utf8') };
    writeFileSync(join(r.repo, 'commitlint.config.js'), "export default { extends: ['@commitlint/config-conventional'] };\n");
    const o = await proposeDrafted(input({ problem: 'An edited problem statement for the greeting.', measureScript: V2 }), env);
    expect(o).toMatchObject({ ok: false, environment: true });
    if (!o.ok) expect(o.reason).toMatch(/cannot be checked: .*commitlint is not installed/);
    expect(readFileSync(paths.contract, 'utf8')).toBe(before.contract);
    expect(readFileSync(join(env.itemsRoot, 'metrics', 'greeting-name.mjs'), 'utf8')).toBe(before.script);
    expect(readLedger(paths.ledger).entries.map((e) => e.event.type)).toEqual(['proposed']);
  });

  it('a ledger that refuses the entry puts the previous contract and script back', async () => {
    expect((await proposeDrafted(input({ measureScript: COUNT_SRC }), env)).ok).toBe(true);
    const paths = itemPaths(env.itemsRoot, 'greeting-name');
    const before = readFileSync(paths.contract, 'utf8');
    chmodSync(paths.ledger, 0o400);
    try {
      const o = await proposeDrafted(input({ problem: 'An edited problem statement for the greeting.', measureScript: V2 }), env);
      expect(o.ok).toBe(false);
      if (!o.ok) expect(o.reason).toMatch(/the proposal could not be recorded \(nothing changed\)/);
      expect(readFileSync(paths.contract, 'utf8')).toBe(before);
      expect(readFileSync(join(env.itemsRoot, 'metrics', 'greeting-name.mjs'), 'utf8')).toBe(COUNT_SRC);
    } finally {
      chmodSync(paths.ledger, 0o600);
    }
  });

  it('a rename that fails after another succeeded puts the first file back and leaves no temp file (all or nothing)', () => {
    const dir = join(r.base, 'replace');
    mkdirSync(join(dir, 'metrics'), { recursive: true });
    const contract = join(dir, 'contract.md');
    const script = join(dir, 'metrics', 'x.mjs');
    writeFileSync(contract, 'old contract\n');
    let calls = 0;
    const failSecond = (from: string, to: string): void => {
      calls += 1;
      if (calls === 2) throw new Error('EIO: the disk said no');
      renameSync(from, to);
    };
    expect(() => replaceFiles([{ file: contract, content: 'new contract\n' }, { file: script, content: 'console.log(2);\n' }], failSecond)).toThrow(/the disk said no/);
    expect(readFileSync(contract, 'utf8')).toBe('old contract\n');
    expect(existsSync(script)).toBe(false);
    expect([...readdirSync(dir), ...readdirSync(join(dir, 'metrics'))].filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // The twin: when every rename works, both are replaced, and the undo puts both back.
    const undo = replaceFiles([{ file: contract, content: 'new contract\n' }, { file: script, content: 'console.log(2);\n' }]);
    expect(readFileSync(contract, 'utf8')).toBe('new contract\n');
    expect(readFileSync(script, 'utf8')).toBe('console.log(2);\n');
    undo();
    expect(readFileSync(contract, 'utf8')).toBe('old contract\n');
    expect(existsSync(script)).toBe(false);
  });

  it('a script path that is a directory: the re-proposal is refused and the contract stays as proposed', async () => {
    expect((await proposeDrafted(input(), env)).ok).toBe(true);
    const paths = itemPaths(env.itemsRoot, 'greeting-name');
    const before = readFileSync(paths.contract, 'utf8');
    mkdirSync(join(env.itemsRoot, 'metrics', 'greeting-name.mjs'), { recursive: true });
    const o = await proposeDrafted(input({ problem: 'An edited problem statement for the greeting.', measureScript: V2 }), env);
    expect(o.ok === false && o.reason).toMatch(/the proposal could not be recorded \(nothing changed\)/);
    expect(readFileSync(paths.contract, 'utf8')).toBe(before);
    expect(readLedger(paths.ledger).entries.map((e) => e.event.type)).toEqual(['proposed']);
  });

  it('twin: an accepted re-proposal replaces both', async () => {
    expect((await proposeDrafted(input({ measureScript: COUNT_SRC }), env)).ok).toBe(true);
    const o = await proposeDrafted(input({ problem: 'An edited problem statement for the greeting.', measureScript: V2 }), env);
    expect(o.ok, o.ok ? '' : o.reason).toBe(true);
    expect(readFileSync(itemPaths(env.itemsRoot, 'greeting-name').contract, 'utf8')).toMatch(/An edited problem statement/);
    expect(readFileSync(join(env.itemsRoot, 'metrics', 'greeting-name.mjs'), 'utf8')).toBe(V2);
  });
});

describe('the before value, read after the yes', () => {
  it('a Measure reading: the last line may be a number, or JSON with a numeric "value" (nothing else)', () => {
    expect(lastNumber('3\n')).toBe(3);
    expect(lastNumber('noise\n{"metric":"src files","value":4}\n')).toBe(4);
    expect(lastNumber('{"metric":"x","value":"4"}')).toBeNull();
    expect(lastNumber('{"metric":"x"}')).toBeNull();
    expect(lastNumber('[4]')).toBeNull();
    expect(lastNumber('four')).toBeNull();
  });

  it.skipIf(!sandboxed)('after approval the harness reads it (confined) and records the ledger\'s metric entry (phase before); the number, never the output', async () => {
    const script = "import { readdirSync } from 'node:fs';\nconsole.log('PRIVATE-NOTE-123');\nconsole.log(JSON.stringify({ metric: 'src files', value: readdirSync('src').length }));\n";
    expect((await proposeDrafted(input({ measureScript: script }), env)).ok).toBe(true);
    recordReply(env.itemsRoot, 'greeting-name', 'yes', 'tty', 'test');
    const b = await readBefore(env, 'greeting-name');
    expect(b?.ok, b?.owner).toBe(true);
    expect(b?.owner).toMatch(/^before value: 1 \(read by the harness at development [0-9a-f]{12}\)$/);
    expect(b?.model).toBe('the harness read the before value after the approval and recorded it in the item ledger');
    const paths = itemPaths(env.itemsRoot, 'greeting-name');
    const entries = readLedger(paths.ledger).entries;
    expect(entries.map((e) => e.event.type)).toEqual(['proposed', 'human_turn', 'approved', 'metric']);
    expect(entries[3]?.event).toMatchObject({ type: 'metric', phase: 'before', reading: { value: 1, ref: 'refs/heads/development', excerpt: '', confinement: detectMechanism() } });
    expect(readFileSync(paths.ledger, 'utf8')).not.toContain('PRIVATE-NOTE-123');
    expect(readFileSync(paths.contract, 'utf8')).toMatch(/before: 1 after: ____/);
    // The value written into the Metric line does not change what was approved.
    expect(itemStatus(env.itemsRoot, 'greeting-name').stage).toBe('approved');
  });

  it.skipIf(!sandboxed)('a failing Measure: the reason and the model\'s line say how it failed, never what it printed; nothing is recorded', async () => {
    for (const [slug, script, model] of [
      ['exits-three', "console.error('PRIVATE-NOTE-456');\nconsole.log('PRIVATE-NOTE-789');\nprocess.exit(3);\n", 'the Measure script exited 3'],
      ['no-number', "console.log('PRIVATE-NOTE-456');\n", 'the Measure script printed no number'],
    ] as const) {
      expect((await proposeDrafted(input({ slug, measureScript: script }), env)).ok).toBe(true);
      recordReply(env.itemsRoot, slug, 'yes', 'tty', 'test');
      const b = await readBefore(env, slug);
      expect(b?.ok).toBe(false);
      expect(b?.model).toBe(model);
      expect(`${b?.owner ?? ''} ${b?.model ?? ''}`).not.toMatch(/PRIVATE-NOTE/);
      expect(readLedger(itemPaths(env.itemsRoot, slug).ledger).entries.map((e) => e.event.type)).toEqual(['proposed', 'human_turn', 'approved']);
    }
  });

  it('the model\'s line for each kind of failure names the kind only', () => {
    expect(readingFailureForModel({ ok: false, reason: 'Measure exited 2 at abc: SECRET', failure: 'exit', code: 2 })).toBe('the Measure script exited 2');
    expect(readingFailureForModel({ ok: false, reason: 'Measure printed no number (got "SECRET")', failure: 'no-number' })).toBe('the Measure script printed no number');
    expect(readingFailureForModel({ ok: false, reason: 'cannot check out abc: SECRET', failure: 'setup' })).toBe('the harness could not run the Measure script');
  });

  it.skipIf(!sandboxed)('the commit\'s .env* files (and a link to one) are gone from the measure checkout; a plain file of the same commit is there (the twin)', async () => {
    writeFileSync(join(r.repo, '.env'), 'API_TOKEN=committed-by-mistake\n');
    mkdirSync(join(r.repo, 'config'), { recursive: true });
    writeFileSync(join(r.repo, 'config', '.env.production'), 'DB_PASSWORD=also-committed\n');
    writeFileSync(join(r.repo, 'config', 'settings.txt'), 'plain\n');
    symlinkSync('../.env', join(r.repo, 'config', 'env-link'));
    git(r.repo, 'add', '-A', '-f');
    git(r.repo, 'commit', '-q', '-m', 'add config');
    git(r.repo, 'branch', '-f', 'development', 'HEAD');
    const script = "import { existsSync } from 'node:fs';\nconst present = ['.env', 'config/.env.production', 'config/env-link'].filter((f) => existsSync(f)).length;\nconsole.log(existsSync('config/settings.txt') ? 100 + present : present);\n";
    expect((await proposeDrafted(input({ measureScript: script }), env)).ok).toBe(true);
    recordReply(env.itemsRoot, 'greeting-name', 'yes', 'tty', 'test');
    const b = await readBefore(env, 'greeting-name');
    expect(b?.ok, b?.owner).toBe(true);
    expect(b?.reading?.value).toBe(100);
  });

  it('envEntries finds every .env* entry at any depth and a link to one, and nothing else', () => {
    const tree = join(r.base, 'tree');
    mkdirSync(join(tree, 'a', 'b'), { recursive: true });
    mkdirSync(join(tree, 'node_modules', 'x'), { recursive: true });
    for (const f of ['.env', 'a/.ENV.local', 'a/b/.envrc', 'a/b/keep.txt', 'node_modules/x/.env']) writeFileSync(join(tree, f), 'x\n');
    symlinkSync('../.env', join(tree, 'a', 'to-env'));
    symlinkSync('b/keep.txt', join(tree, 'a', 'to-keep'));
    expect(envEntries(tree)).toEqual(['.env', 'a/.ENV.local', 'a/b/.envrc', 'a/to-env']);
  });

  it.skipIf(!sandboxed)('readMetric itself never quotes the output (file mode too)', async () => {
    mkdirSync(join(env.itemsRoot, 'metrics'), { recursive: true });
    writeFileSync(join(env.itemsRoot, 'metrics', 'loud.mjs'), "console.log('PRIVATE-NOTE-000');\nprocess.exit(4);\n");
    const res = await readMetric({ harnessRoot: HARNESS_ROOT, itemsRoot: env.itemsRoot, repoDir: r.repo, ref: 'HEAD', measure: { script: 'metrics/loud.mjs', args: [], text: 'node metrics/loud.mjs' }, label: 'loud' });
    expect(res).toMatchObject({ ok: false, failure: 'exit', code: 4 });
    if (!res.ok) expect(res.reason).not.toContain('PRIVATE-NOTE');
  });
});

describe('proposeImported (/import)', () => {
  it('a hand-written contract is proposed as written, its Measure script copied from next to it and shown; read only after the yes', async () => {
    const dir = join(r.base, 'drafts');
    mkdirSync(dir, { recursive: true });
    const text = draftedContract(input({ slug: 'hand-made' }), { repo: 'acme/tiny-web', base: 'development', measure: 'node metrics/hand.mjs' });
    writeFileSync(join(dir, 'hand-made.md'), text);
    writeFileSync(join(dir, 'hand.mjs'), "console.log('7');\n");
    // A relative path resolves against the directory the owner typed it in.
    const o = await proposeImported('drafts/hand-made.md', r.base, env);
    expect(o.ok, o.ok ? '' : o.reason).toBe(true);
    if (!o.ok) return;
    expect(o.proposal.script).toEqual({ path: 'metrics/hand.mjs', text: "console.log('7');\n" });
    expect(readFileSync(join(env.itemsRoot, 'metrics', 'hand.mjs'), 'utf8')).toBe("console.log('7');\n");
    expect(readLedger(itemPaths(env.itemsRoot, 'hand-made').ledger).entries.map((e) => e.event.type)).toEqual(['proposed']);
    if (!sandboxed) return;
    recordReply(env.itemsRoot, 'hand-made', 'yes', 'tty', 'test');
    expect((await readBefore(env, 'hand-made'))?.reading?.value).toBe(7);
  });

  it('twin: a contract whose Measure script is missing is refused, naming the file to add', async () => {
    const dir = join(r.base, 'drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hand-made.md'), draftedContract(input({ slug: 'hand-made' }), { repo: 'acme/tiny-web', base: 'development', measure: 'node metrics/hand.mjs' }));
    const o = await proposeImported(join(dir, 'hand-made.md'), r.base, env);
    expect(o.ok === false && o.reason).toMatch(/put hand\.mjs next to the contract/);
  });

  it('a Measure script path another item\'s contract names is refused, both ways in, and that item\'s script stays as it was', async () => {
    expect((await proposeDrafted(input({ measureScript: COUNT_SRC }), env)).ok).toBe(true);
    const dir = join(r.base, 'drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hand-made.md'), draftedContract(input({ slug: 'hand-made' }), { repo: 'acme/tiny-web', base: 'development', measure: 'node metrics/greeting-name.mjs' }));
    writeFileSync(join(dir, 'greeting-name.mjs'), "console.log('999');\n");
    const imported = await proposeImported(join(dir, 'hand-made.md'), r.base, env);
    expect(imported.ok === false && imported.reason).toMatch(/metrics\/greeting-name\.mjs is the Measure script of item greeting-name in this repository's records/);
    expect(readFileSync(join(env.itemsRoot, 'metrics', 'greeting-name.mjs'), 'utf8')).toBe(COUNT_SRC);
    expect(existsSync(itemPaths(env.itemsRoot, 'hand-made').contract)).toBe(false);
    // The other way round: an imported item holds metrics/footer-text.mjs, so a drafted footer-text with a script is refused.
    writeFileSync(join(dir, 'other.md'), draftedContract(input({ slug: 'other' }), { repo: 'acme/tiny-web', base: 'development', measure: 'node metrics/footer-text.mjs' }));
    writeFileSync(join(dir, 'footer-text.mjs'), "console.log('5');\n");
    expect((await proposeImported(join(dir, 'other.md'), r.base, env)).ok).toBe(true);
    const drafted = await proposeDrafted(input({ slug: 'footer-text', measureScript: "console.log('6');\n" }), env);
    expect(drafted.ok === false && drafted.reason).toMatch(/metrics\/footer-text\.mjs is the Measure script of item other/);
    expect(readFileSync(join(env.itemsRoot, 'metrics', 'footer-text.mjs'), 'utf8')).toBe("console.log('5');\n");
  });

  it('twin: a script path no other contract names is written; re-proposing an item keeps its own script path', async () => {
    expect((await proposeDrafted(input({ measureScript: COUNT_SRC }), env)).ok).toBe(true);
    expect((await proposeDrafted(input({ problem: 'An edited problem statement for the greeting.', measureScript: COUNT_SRC }), env)).ok).toBe(true);
    const dir = join(r.base, 'drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hand-made.md'), draftedContract(input({ slug: 'hand-made' }), { repo: 'acme/tiny-web', base: 'development', measure: 'node metrics/hand.mjs' }));
    writeFileSync(join(dir, 'hand.mjs'), "console.log('7');\n");
    expect((await proposeImported(join(dir, 'hand-made.md'), r.base, env)).ok).toBe(true);
  });

  it('a hand-written contract with an escape sequence, or a Base that is no branch, is refused', async () => {
    const dir = join(r.base, 'drafts');
    mkdirSync(dir, { recursive: true });
    const plain = draftedContract(input({ slug: 'hand-made' }), { repo: 'acme/tiny-web', base: 'development', measure: 'none' });
    writeFileSync(join(dir, 'hand-made.md'), plain.replace('Problem: The', 'Problem: The \u001b[8mhidden\u001b[0m'));
    const esc = await proposeImported(join(dir, 'hand-made.md'), r.base, env);
    expect(esc.ok === false && esc.reason).toMatch(/control characters \(U\+001B\)/);
    writeFileSync(join(dir, 'hand-made.md'), plain.replace('Base: development', 'Base: stash'));
    const stash = await proposeImported(join(dir, 'hand-made.md'), r.base, env);
    expect(stash.ok === false && stash.reason).toMatch(/base "stash" is neither a branch of origin/);
    writeFileSync(join(dir, 'hand-made.md'), plain);
    expect((await proposeImported(join(dir, 'hand-made.md'), r.base, env)).ok).toBe(true);
  });
});
