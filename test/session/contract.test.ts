/**
 * A session's contract: the harness writes it in the format the gates parse, fills Repo and Base,
 * reads the before value with the Measure script the model drafted, and proposes it. Each acceptance
 * has its refusal: "Measure: none" is an explicit choice (a placeholder is not); "local:<name>" is a
 * Repo (a bare name is not); a Measure that prints {"value":n} is a reading (one that prints no number
 * is not); an incomplete contract is never written or proposed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preconditions } from '../../src/core/close.ts';
import { exec } from '../../src/core/exec.ts';
import { appendLedger, itemPaths, itemStatus, parseContract, readLedger, recordReply } from '../../src/core/items.ts';
import { lastNumber } from '../../src/core/measure.ts';
import { detectMechanism } from '../../src/core/sandbox.ts';
import { defaultBase, draftedContract, incompleteReason, proposeDrafted, proposeImported, repoField, repoSlugFromRemote, type ProposalEnv } from '../../src/session/contract.ts';
import { git, proposal, webRepo, type WebRepo } from './helpers.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import type { ProposeContractInputT } from '../../plugins/tools/propose_contract.ts';

let r: WebRepo;
let env: ProposalEnv;
beforeEach(() => {
  r = webRepo();
  env = { top: r.repo, itemsRoot: join(r.home, 'items-root'), sessionId: 'test', harnessRoot: HARNESS_ROOT, exec, baseSha: git(r.repo, 'rev-parse', 'HEAD') };
});
afterEach(() => r.cleanup());

const input = (over: Record<string, unknown> = {}): ProposeContractInputT => proposal(over) as unknown as ProposeContractInputT;

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
});

describe('a Measure reading', () => {
  it('the last line may be a number, or JSON with a numeric "value" (nothing else)', () => {
    expect(lastNumber('3\n')).toBe(3);
    expect(lastNumber('noise\n{"metric":"src files","value":4}\n')).toBe(4);
    expect(lastNumber('{"metric":"x","value":"4"}')).toBeNull();
    expect(lastNumber('{"metric":"x"}')).toBeNull();
    expect(lastNumber('[4]')).toBeNull();
    expect(lastNumber('four')).toBeNull();
  });
});

describe('proposeDrafted', () => {
  it('writes the contract outside the repository and records the proposal (Measure: none: no reading)', async () => {
    const o = await proposeDrafted(input(), env);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.proposal).toMatchObject({ slug: 'greeting-name', seq: 1, before: null });
    expect(readLedger(itemPaths(env.itemsRoot, 'greeting-name').ledger).entries.map((e) => e.event.type)).toEqual(['proposed']);
    expect(existsSync(join(r.repo, 'docs'))).toBe(false);
    expect(git(r.repo, 'status', '--porcelain')).toBe('');
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

  it.skipIf(detectMechanism() === 'none')('a drafted Measure script is run by the harness (confined) for the before value', async () => {
    const script = "import { readdirSync } from 'node:fs';\nconsole.log(JSON.stringify({ metric: 'src files', value: readdirSync('src').length }));\n";
    const o = await proposeDrafted(input({ measureScript: script }), env);
    expect(o.ok, o.ok ? '' : o.reason).toBe(true);
    if (!o.ok) return;
    expect(o.proposal.before?.value).toBe(1);
    expect(readFileSync(join(env.itemsRoot, 'metrics', 'greeting-name.mjs'), 'utf8')).toBe(script);
    expect(parseContract(o.proposal.text).fields.Measure).toBe('node metrics/greeting-name.mjs');
    expect(o.proposal.text).toMatch(/before: 1 after: ____/);
  });

  it.skipIf(detectMechanism() === 'none')('twin: a Measure that prints no number is no reading, and nothing is proposed', async () => {
    const o = await proposeDrafted(input({ measureScript: "console.log('lots');\n" }), env);
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.reason).toMatch(/the before value could not be read: Measure printed no number/);
    expect(existsSync(itemPaths(env.itemsRoot, 'greeting-name').ledger)).toBe(false);
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
    expect(reasons.join(' ')).toMatch(/no before value/);
  });
});

describe('proposeImported (/import)', () => {
  it('a hand-written contract is proposed as written, its Measure script copied from next to it', async () => {
    const dir = join(r.base, 'drafts');
    mkdirSync(dir, { recursive: true });
    const text = draftedContract(input({ slug: 'hand-made' }), { repo: 'acme/tiny-web', base: 'development', measure: 'node metrics/hand.mjs' });
    writeFileSync(join(dir, 'hand-made.md'), text);
    writeFileSync(join(dir, 'hand.mjs'), "console.log('7');\n");
    // A relative path resolves against the directory the owner typed it in.
    const o = await proposeImported('drafts/hand-made.md', r.base, env);
    if (detectMechanism() === 'none') return;
    expect(o.ok, o.ok ? '' : o.reason).toBe(true);
    expect(readFileSync(join(env.itemsRoot, 'metrics', 'hand.mjs'), 'utf8')).toBe("console.log('7');\n");
    if (o.ok) expect(o.proposal.before?.value).toBe(7);
  });

  it('twin: a contract whose Measure script is missing is refused, naming the file to add', async () => {
    const dir = join(r.base, 'drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hand-made.md'), draftedContract(input({ slug: 'hand-made' }), { repo: 'acme/tiny-web', base: 'development', measure: 'node metrics/hand.mjs' }));
    const o = await proposeImported(join(dir, 'hand-made.md'), r.base, env);
    expect(o.ok === false && o.reason).toMatch(/put hand\.mjs next to the contract/);
  });
});
