/**
 * What a session is offered and which model it talks to, each with its twin:
 *   - propose_contract is offered in a session, never in file mode (whose tool list is unchanged), and
 *     refuses when called outside a session;
 *   - the default model is the first allowlisted model whose driver serves it and can start; a driver
 *     that cannot start (its key is missing) is skipped with its own reason; none: a clear refusal;
 *   - an explicit model off the allowlist is refused before any token is spent.
 */
import { describe, expect, it } from 'vitest';
import claudePlugin from '../../plugins/drivers/claude.ts';
import openaiPlugin from '../../plugins/drivers/openai.ts';
import scriptedPlugin from '../../plugins/drivers/scripted.ts';
import proposeContract from '../../plugins/tools/propose_contract.ts';
import { toolSpecs } from '../../src/core/registry.ts';
import { allowlistedModels, pickModel } from '../../src/session/models.ts';
import type { Driver, DriverPlugin, ModelPolicy, RunContext } from '../../src/core/types.ts';
import { realRegistry } from './helpers.ts';

describe('session-only tools', () => {
  it('propose_contract is offered in a session', async () => {
    const reg = await realRegistry();
    expect(toolSpecs(reg.tools, 'brownfield', { session: true }).map((t) => t.name)).toContain('propose_contract');
  });

  it('file-mode twin: never offered without session (brownfield or greenfield), so file mode lists exactly what it did', async () => {
    const reg = await realRegistry();
    for (const kind of ['brownfield', 'greenfield'] as const) {
      const names = toolSpecs(reg.tools, kind).map((t) => t.name);
      expect(names).not.toContain('propose_contract');
      expect(names).toEqual(reg.tools.filter((t) => t.plugin.sessionOnly !== true && (t.plugin.availableIn ?? [kind]).includes(kind)).map((t) => t.plugin.name));
    }
  });

  it('called outside a session it refuses; its effect is control, never write', async () => {
    expect(proposeContract.effect).toBe('control');
    const r = await proposeContract.run({ slug: 'x' } as never, {} as RunContext);
    expect(r).toMatchObject({ ok: false });
    expect(r.summary).toMatch(/only an interactive session can propose a contract/);
  });
});

describe('drivers say which models they serve (the core names none)', () => {
  it('each driver serves its own family only', () => {
    expect(openaiPlugin.serves?.('gpt-5.6-luna')).toBe(true);
    expect(openaiPlugin.serves?.('claude-haiku-4-5-20251001')).toBe(false);
    expect(claudePlugin.serves?.('claude-haiku-4-5-20251001')).toBe(true);
    expect(claudePlugin.serves?.('gpt-5.6-luna')).toBe(false);
    expect(scriptedPlugin.serves?.('scripted:demo.json')).toBe(true);
    expect(scriptedPlugin.serves?.('gpt-5.6-luna')).toBe(false);
  });
});

function fakePlugin(name: string, family: string, key: string | null): DriverPlugin {
  return {
    kind: 'driver',
    name,
    description: name,
    serves: (m) => m.startsWith(family),
    create: (o) => {
      if (key !== null && o.env[key] === undefined) throw new Error(`${key} is not set`);
      const d: Driver = { name, model: o.model ?? `${family}default`, tokenCounter: 'x', complete: async () => { throw new Error('no'); }, countTokens: async () => 0 };
      return d;
    },
  };
}

const price = { input: 1, cachedInput: 0.1, output: 2 };
const policy: ModelPolicy = { allow: ['alpha-1', 'beta-1', 'replay:*'], prices: { 'alpha-1': price, 'beta-1': price, 'replay:*': { input: 0, cachedInput: 0, output: 0 } }, maxRunUsd: 2 };
const plugins = [fakePlugin('a', 'alpha-', 'A_KEY'), fakePlugin('b', 'beta-', 'B_KEY'), fakePlugin('replay', 'replay:', null)];
const base = { plugins, policy, harnessRoot: '/h' };

describe('pickModel', () => {
  it('the first allowlisted model whose driver can start: alpha when its key is present', () => {
    const p = pickModel({}, { ...base, env: { A_KEY: 'k', B_KEY: 'k' } });
    expect(p.ok && p.driver.model).toBe('alpha-1');
  });

  it('a driver without its key is skipped: beta is next', () => {
    const p = pickModel({}, { ...base, env: { B_KEY: 'k' } });
    expect(p.ok && p.driver.model).toBe('beta-1');
  });

  it('no key at all: a clear refusal naming each model and why (a "*" pattern is never picked)', () => {
    const p = pickModel({}, { ...base, env: {} });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.reason).toMatch(/no model on the allowlist can start/);
      expect(p.reason).toContain('alpha-1 (a): A_KEY is not set');
      expect(p.reason).toContain('beta-1 (b): B_KEY is not set');
      expect(p.reason).toMatch(/env\.development/);
    }
  });

  it('an explicit model off the allowlist is refused; an allowlisted one is used', () => {
    const off = pickModel({ model: 'alpha-9' }, { ...base, env: { A_KEY: 'k' } });
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.reason).toMatch(/not on the allowlist/);
    const on = pickModel({ model: 'beta-1' }, { ...base, env: { B_KEY: 'k' } });
    expect(on.ok && on.driver.name).toBe('b');
  });

  it('an explicit driver is used as given (e.g. a replay driver with its options)', () => {
    const p = pickModel({ driver: 'replay', model: 'replay:demo' }, { ...base, env: {} });
    expect(p.ok && p.driver.model).toBe('replay:demo');
    expect(pickModel({ driver: 'nope' }, { ...base, env: {} })).toMatchObject({ ok: false });
  });

  it('/model lists every allowlisted model that is not a pattern', () => {
    expect(allowlistedModels(policy)).toEqual(['alpha-1', 'beta-1']);
  });
});
