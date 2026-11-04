/**
 * Habit 5 (docs/workflow.md, What breaks): commits and PRs that say nothing. Each rule is a pair: the
 * content-free version is refused with the reason, the real one passes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { contractVerdict, parseContract } from '../../src/core/items.ts';
import {
  commitHeaderProblems,
  commitMessage,
  fillPrTemplate,
  parseHeader,
  prDescription,
  repoCommitlint,
  ticketLine,
  trailerProblems,
} from '../../src/core/ship-text.ts';
import { contractFor } from '../support/items.ts';
import { isolatedExec, repoTmp } from './helpers.ts';

const tmp = repoTmp('ship-text');
afterAll(() => tmp.cleanup());

describe('commit header (the contract Commit line)', () => {
  it.each([
    ['patch', /Conventional Commits header/],
    ['fix: comment fixes', /says nothing/],
    ['fix: minor changes to code', /says nothing/],
    ['chore: checkpoint 12', /numbered checkpoint/],
    ['feat(app): round 5', /numbered checkpoint/],
    ['feature(app): add search to the list', /type "feature" is not one of/],
    ['fix(auth): Require the admin role on routes.', /full stop/],
    [`fix(auth): ${'require the admin role '.repeat(6).trim()}`, /at most 100/],
  ])('refuses %j', (header, why) => {
    expect(commitHeaderProblems(header).join('; ')).toMatch(why);
  });

  it.each([
    'fix(AUTH): Require the admin role on the ten admin-only routes',
    'fix(members): refetch every Members list after a member is added',
    'fix(signals): replace a refetched page instead of appending it again',
    'chore(deps): Bump zod to 4.1',
    'feat!: drop the v1 users route',
  ])('accepts %j', (header) => {
    expect(commitHeaderProblems(header)).toEqual([]);
  });

  it('a contract whose Commit line is missing or says nothing is incomplete (no edit happens)', () => {
    const missing = contractFor('x', { Commit: '' });
    expect(parseContract(missing).missing).toContain('Commit');
    const vague = contractFor('x', { Commit: 'fix: patch' });
    const v = contractVerdict({ slug: 'x', contract: '/c', ledger: '/l', dir: '/d' } as never, () => vague);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/says nothing/);
    expect(parseContract(contractFor('x')).complete).toBe(true);
  });

  it('parses type, scope, breaking mark and subject', () => {
    expect(parseHeader('feat(api)!: drop the v1 users route')).toEqual({ type: 'feat', scope: 'api', breaking: true, subject: 'drop the v1 users route' });
    expect(parseHeader('no colon here')).toBeNull();
  });
});

describe('commit message', () => {
  const c = parseContract(contractFor('members', { Commit: 'fix(members): refetch every Members list after a member is added', Problem: 'The list keeps its old rows after Add member. '.repeat(4).trim() }));

  it('is the approved header and the contract, wrapped at 72, with no trailers', () => {
    const msg = commitMessage({ contract: c, slug: 'members', runId: 'members-openai-1', before: '1' });
    const lines = msg.split('\n');
    expect(lines[0]).toBe('fix(members): refetch every Members list after a member is added');
    expect(lines[1]).toBe('');
    expect(lines.every((l) => l.length <= 72)).toBe(true);
    expect(msg).toContain('Scenarios:\n- WHEN the run finishes THEN its gates decide');
    expect(msg).toContain('before 1;');
    expect(msg).toContain('Harness run: members-openai-1');
    expect(trailerProblems(msg)).toEqual([]);
  });

  it.each([
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    '🤖 Generated with Claude Code',
    'Assisted-by: GPT-5.6 Luna',
  ])('refuses the AI attribution line %j', (line) => {
    expect(trailerProblems(`fix(x): do the real thing here\n\nbody\n\n${line}\n`)).toHaveLength(1);
  });

  it('a person sign-off is not attribution', () => {
    expect(trailerProblems('fix(x): do the real thing here\n\nSigned-off-by: Abdul Basit <a@b.c>\n')).toEqual([]);
  });
});

const TEMPLATE = `# Description

Brief description of the changes made in this pull request

<!-- what reviewers should look at first -->

# Ticket Link

Ticket # | Ticket Title

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)

# Checklist:

- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my code
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
`;

describe('PR template', () => {
  const c = parseContract(contractFor('members', { Commit: 'fix(members): refetch every Members list after a member is added' }));
  const header = parseHeader(c.fields.Commit ?? '');
  if (header === null) throw new Error('fixture header');
  const green = new Map([['standards', 'pass'], ['observed-red', 'pass'], ['tests-green', 'pass']]);
  const fill = (gates: Map<string, string>) => ({ description: prDescription(c, '1', 'members'), ticket: ticketLine(c, 'members'), header, gates });

  it('replaces the placeholders, ticks only what a gate proved, and leaves the rest to the reviewer', () => {
    const f = fillPrTemplate(TEMPLATE, fill(green));
    expect(f.untouched).toEqual([]);
    expect(f.body).not.toContain('Brief description of the changes');
    expect(f.body).not.toContain('Ticket # | Ticket Title');
    expect(f.body).not.toContain('<!--');
    expect(f.body).toContain('Test fixture item members');
    expect(f.body).toContain('**Metric:** fixture metric (one run): before **1**');
    expect(f.body).toContain('No ticket: backlog item `members`');
    expect(f.body).toContain('- [x] Bug fix (non-breaking change which fixes an issue)');
    expect(f.body).toContain('- [ ] New feature');
    expect(f.body).toContain('- [x] I have added tests that prove my fix is effective or that my feature works (observed-red:');
    expect(f.body).toContain('- [x] New and existing unit tests pass locally with my changes (tests-green:');
    expect(f.body).toContain('- [ ] I have performed a self-review of my code (left for the reviewer: not checked by the harness)');
    expect(f.forReviewer).toEqual(['I have performed a self-review of my code']);
  });

  it('a box whose gate did not pass stays unticked', () => {
    const f = fillPrTemplate(TEMPLATE, fill(new Map([['standards', 'pass'], ['observed-red', 'unproven'], ['tests-green', 'pass']])));
    expect(f.body).toContain('- [ ] I have added tests that prove my fix is effective or that my feature works (left for the reviewer');
  });

  it('template text the harness cannot fill is reported untouched (ship refuses it)', () => {
    const f = fillPrTemplate(`${TEMPLATE}\n## Screenshots\n\nAdd screenshots of the UI change here\n`, fill(green));
    expect(f.untouched).toEqual(['Add screenshots of the UI change here']);
  });

  it('a Ticket line in the contract fills the ticket placeholder', () => {
    const withTicket = parseContract(contractFor('members', { Ticket: 'MYSF-1234 | Members list refresh' }));
    expect(ticketLine(withTicket, 'members')).toBe('MYSF-1234 | Members list refresh');
  });
});

describe("the repository's own commitlint (run confined)", () => {
  let n = 0;
  function repo(files: Record<string, string>): string {
    const dir = join(tmp.dir, `call-${++n}`, 'repo');
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  /** A stand-in for @commitlint/cli: rejects an empty type the way commitlint reports it. */
  const STRICT_CLI = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(/^[a-z]+(\\([^)]+\\))?: \\S/.test(s)){process.exit(0)}console.log('✖   type may not be empty [type-empty]');process.exit(1)});`;
  const LAX_CLI = `process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;

  it('no config: none (the built-in rules decide)', async () => {
    const v = await repoCommitlint(isolatedExec, repo({ 'package.json': '{}' }), 'fix(x): do the real thing here\n');
    expect(v.status).toBe('none');
  });

  it('a config without its commitlint installed is unproven (ship refuses)', async () => {
    const v = await repoCommitlint(isolatedExec, repo({ 'commitlint.config.js': 'module.exports = {};\n' }), 'fix(x): do the real thing here\n');
    expect(v.status).toBe('unproven');
    expect(v.summary).toMatch(/not installed/);
  });

  it('rejects what the repository rejects, naming its rule; accepts the rest', async () => {
    const dir = repo({ 'commitlint.config.js': 'module.exports = {};\n', 'node_modules/@commitlint/cli/cli.js': STRICT_CLI });
    const bad = await repoCommitlint(isolatedExec, dir, 'patch\n');
    expect(bad.status).toBe('fail');
    expect(bad.details).toEqual(['✖   type may not be empty [type-empty]']);
    const good = await repoCommitlint(isolatedExec, dir, 'fix(x): do the real thing here\n');
    expect(good.status).toBe('pass');
    expect(good.summary).toMatch(/accepts the message/);
  });

  it('a config that accepts "patch" checks nothing, and the verdict says so', async () => {
    const dir = repo({ 'commitlint.config.js': 'export default { extends: [], rules: {} };\n', 'node_modules/@commitlint/cli/cli.js': LAX_CLI });
    const v = await repoCommitlint(isolatedExec, dir, 'fix(x): do the real thing here\n');
    expect(v.status).toBe('pass');
    expect(v.summary).toMatch(/accepts even "patch": it checks nothing/);
  });
});
