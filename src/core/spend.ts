/**
 * Model allowlist and spend cap (habit 9 in docs/workflow.md: cost blow-ups. An expensive model was
 * used after I had asked for the cheap one three times, and my bill showed about $2.10 on it against
 * $0.04 on the cheap one; every driver defaults to its provider's large model when no --model is given).
 * The core names no model: the allowlist and the prices are harness.config.json's.
 *
 *   allowlist  harness.config.json `models.allow`: the model ids a run may use ("scripted:*" style
 *              prefixes allowed). Anything else, a driver default included, is refused before the
 *              first model turn, and a provider that serves another model mid-run stops the run.
 *   prices     `models.prices`: USD per million tokens per model. An allowed model without a price
 *              is refused too: a cap that cannot be computed is no cap.
 *   cap        `models.maxRunUsd`: before every request the loop adds that request's worst case
 *              (its input tokens at the uncached rate plus the full output budget) to what the run
 *              has spent; a request that could pass the cap is never sent.
 *
 * Fail closed: prices are upper bounds (the config says where each comes from), cached input is
 * charged at the cache-read rate only when the provider reports it as cached, and usage a driver
 * does not report (an offline replay) costs nothing because nothing was sent to a provider.
 */
import type { ModelPrice, ModelPolicy } from './types.ts';

/** A served model with the driver's tier note removed ("model-a (compat, uncached)" -> "model-a"). */
export function normalizeModel(model: string): string {
  return model.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A model id matches an entry when it is the entry, a dated snapshot of it ("model-a-2026-08-01", as
 * providers report a served model), or, for an entry ending in "*", starts with it. Never a different
 * model of the same family: "model-a" does not match "model-a-pro".
 */
export function matchesModel(pattern: string, model: string): boolean {
  if (pattern.endsWith('*')) return model.startsWith(pattern.slice(0, -1));
  return model === pattern || new RegExp(`^${escape(pattern)}-(\\d{4}-\\d{2}-\\d{2}|\\d{8})$`).test(model);
}

export function modelAllowed(policy: ModelPolicy, model: string): boolean {
  const m = normalizeModel(model);
  return policy.allow.some((p) => matchesModel(p, m));
}

/** The price of a model: an exact (or snapshot) entry first, then the longest matching prefix pattern. */
export function priceOf(policy: ModelPolicy, model: string): ModelPrice | null {
  const m = normalizeModel(model);
  const keys = Object.keys(policy.prices);
  const exact = keys.find((k) => !k.endsWith('*') && matchesModel(k, m));
  if (exact !== undefined) return policy.prices[exact] ?? null;
  const pattern = keys.filter((k) => k.endsWith('*') && matchesModel(k, m)).sort((a, b) => b.length - a.length)[0];
  return pattern === undefined ? null : (policy.prices[pattern] ?? null);
}

export type PolicyVerdict = { ok: true; price: ModelPrice } | { ok: false; reason: string };

/** Whether a run may start on this driver's model (checked before the first model turn). */
export function modelPolicyVerdict(policy: ModelPolicy, driver: string, model: string): PolicyVerdict {
  const allowed = policy.allow.join(', ') || '(none)';
  if (!modelAllowed(policy, model)) {
    return { ok: false, reason: `model "${model}" on the ${driver} driver is not on the allowlist (harness.config.json models.allow: ${allowed}); pass --model with an allowed id, or set HARNESS_${driver.toUpperCase()}_MODEL` };
  }
  const price = priceOf(policy, model);
  if (price === null) return { ok: false, reason: `model "${model}" is allowed but has no price in harness.config.json models.prices, so the spend cap of $${policy.maxRunUsd} could not be enforced` };
  return { ok: true, price };
}

/** USD for one request: uncached input at the input rate, cached input at the cache-read rate, output at the output rate. */
export function turnCostUsd(usage: { input: number; cached: number; output: number }, price: ModelPrice): number {
  const cached = Math.min(Math.max(0, usage.cached), Math.max(0, usage.input));
  const uncached = Math.max(0, usage.input - cached);
  return (uncached * price.input + cached * price.cachedInput + Math.max(0, usage.output) * price.output) / 1_000_000;
}

/** Dollars: four decimals under $1 (a cap check must never read "$0.10 would pass $0.10"). */
export function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/** What a run has spent, and whether its next request may be sent. */
export class SpendMeter {
  spentUsd = 0;
  constructor(
    readonly capUsd: number,
    readonly price: ModelPrice,
    readonly model: string,
  ) {}

  /** The worst case of a request with `inputTokens` and an output budget of `maxOutputTokens`. */
  worstCase(inputTokens: number, maxOutputTokens: number): number {
    return turnCostUsd({ input: inputTokens, cached: 0, output: maxOutputTokens }, this.price);
  }

  /** Null when the request may be sent; otherwise why it may not (it could pass the cap). */
  refuseNext(inputTokens: number, maxOutputTokens: number): string | null {
    const worst = this.worstCase(inputTokens, maxOutputTokens);
    if (this.spentUsd + worst <= this.capUsd) return null;
    return `spend cap: this run has spent ${usd(this.spentUsd)} on ${this.model}; the next request (${inputTokens} input tokens, up to ${maxOutputTokens} output) could cost up to ${usd(worst)}, which would pass the cap of ${usd(this.capUsd)} (harness.config.json models.maxRunUsd)`;
  }

  add(usage: { input: number; cached: number; output: number }): number {
    const c = turnCostUsd(usage, this.price);
    this.spentUsd += c;
    return c;
  }
}

/** The run summary's spend line. */
export function spendLine(m: SpendMeter): string {
  const p = m.price;
  return `${usd(m.spentUsd)} of the ${usd(m.capUsd)} cap (${m.model}; USD per million input / cached / output tokens: ${p.input} / ${p.cachedInput} / ${p.output}, upper bounds)`;
}
