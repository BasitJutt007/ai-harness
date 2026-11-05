/**
 * Which model a session talks to.
 *
 * Default: the first model on harness.config.json `models.allow` (in order; "*" patterns are not a
 * model and are skipped) that a driver plugin serves (DriverPlugin.serves) and that driver can start,
 * i.e. its provider key is present. An explicit --driver/--model is used as given. Either way the model
 * must pass the same policy as file mode (allowlisted and priced), or the session does not start.
 *
 * Nothing here names a provider: drivers say what they serve and what they need (a driver that cannot
 * start says why, e.g. which key is missing, in its own words).
 */
import { modelPolicyVerdict } from '../core/spend.ts';
import type { Driver, DriverPlugin, ModelPolicy, ModelPrice } from '../core/types.ts';

export interface ModelRequest {
  /** --driver: a driver plugin by name. */
  driver?: string | undefined;
  /** --model: a model id. */
  model?: string | undefined;
  /** --driver-opt k=v pairs (e.g. a scripted driver's script). */
  options?: Record<string, string> | undefined;
}

export type ModelPick = { ok: true; driver: Driver; plugin: DriverPlugin; price: ModelPrice } | { ok: false; reason: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface PickEnv {
  plugins: readonly DriverPlugin[];
  policy: ModelPolicy;
  env: NodeJS.ProcessEnv;
  harnessRoot: string;
}

function start(plugin: DriverPlugin, model: string | undefined, options: Record<string, string>, e: PickEnv): { driver: Driver } | { error: string } {
  try {
    return { driver: plugin.create({ ...(model !== undefined ? { model } : {}), options, env: e.env, harnessRoot: e.harnessRoot }) };
  } catch (err) {
    return { error: errMsg(err) };
  }
}

function withPolicy(plugin: DriverPlugin, driver: Driver, e: PickEnv): ModelPick {
  const v = modelPolicyVerdict(e.policy, driver.name, driver.model);
  return v.ok ? { ok: true, driver, plugin, price: v.price } : { ok: false, reason: v.reason };
}

/** The driver plugin that serves `model`, or null. */
export function servingPlugin(plugins: readonly DriverPlugin[], model: string): DriverPlugin | null {
  return plugins.find((p) => {
    try {
      return p.serves?.(model) === true;
    } catch {
      return false;
    }
  }) ?? null;
}

/** The session's model: as asked (--driver / --model), else the first allowlisted model whose driver can start. */
export function pickModel(req: ModelRequest, e: PickEnv): ModelPick {
  const options = req.options ?? {};
  if (req.driver !== undefined) {
    const plugin = e.plugins.find((p) => p.name === req.driver);
    if (plugin === undefined) return { ok: false, reason: `unknown driver "${req.driver}" (drivers: ${e.plugins.map((p) => p.name).join(', ') || '(none)'})` };
    const s = start(plugin, req.model, options, e);
    if ('error' in s) return { ok: false, reason: `driver "${plugin.name}" could not start: ${s.error}` };
    return withPolicy(plugin, s.driver, e);
  }
  if (req.model !== undefined) {
    const plugin = servingPlugin(e.plugins, req.model);
    if (plugin === null) return { ok: false, reason: `no driver serves model "${req.model}" (pass --driver <name>; drivers: ${e.plugins.map((p) => p.name).join(', ') || '(none)'})` };
    const s = start(plugin, req.model, options, e);
    if ('error' in s) return { ok: false, reason: `model "${req.model}" (driver ${plugin.name}) could not start: ${s.error}` };
    return withPolicy(plugin, s.driver, e);
  }
  const tried: string[] = [];
  for (const model of e.policy.allow) {
    if (model.endsWith('*')) continue;
    const plugin = servingPlugin(e.plugins, model);
    if (plugin === null) {
      tried.push(`${model}: no driver serves it`);
      continue;
    }
    const s = start(plugin, model, options, e);
    if ('error' in s) {
      tried.push(`${model} (${plugin.name}): ${s.error}`);
      continue;
    }
    return withPolicy(plugin, s.driver, e);
  }
  return {
    ok: false,
    reason: `no model on the allowlist can start (harness.config.json models.allow): ${tried.join('; ') || 'the allowlist names no model'}. Put the provider key in ~/.sf-harness/env.development (KEY=value lines), or pass --driver and --model`,
  };
}

/** The models a session may switch to with /model: every non-pattern allowlist entry. */
export function allowlistedModels(policy: ModelPolicy): string[] {
  return policy.allow.filter((m) => !m.endsWith('*'));
}
