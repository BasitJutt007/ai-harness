/**
 * No provider logic in the core: src/core names no provider and reads no provider's error
 * format. Rate-limit formats (Google's RetryInfo / RESOURCE_EXHAUSTED, an echoed
 * X-RateLimit-Reset, `retry-after-ms`, ...) live in plugins/drivers (Driver.retryAfterMs); the
 * core keeps only the standard Retry-After header of an HTTP 429/503 error.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { providerVocabulary } from '../../src/core/cli.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';

/** Provider error formats and wording: each is specific to one provider or gateway. */
const VENDOR_ERROR_STRINGS: RegExp[] = [
  /RESOURCE_EXHAUSTED/,
  /\bretryDelay\b/,
  /RetryInfo/,
  /QuotaFailure/,
  /x-ratelimit/i,
  /retry-after-ms/i,
  /rate_limit_error/,
  /overloaded_error/,
  /insufficient_quota/,
  /model_not_found/,
  /generate_content/,
  /googleapis|generativelanguage|openrouter/i,
];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(abs));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(abs);
  }
  return out.sort();
}

/** `file:line: match` for every vendor error string or provider term in the .ts files under `dir`. */
function vendorHits(dir: string, terms: string[]): string[] {
  const hits: string[] = [];
  const termRes = terms.map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'), 'i'));
  for (const file of filesUnder(dir)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const re of [...VENDOR_ERROR_STRINGS, ...termRes]) {
        const m = re.exec(line);
        if (m !== null) hits.push(`${file.slice(dir.length + 1)}:${i + 1}: ${m[0]}`);
      }
    });
  }
  return hits;
}

describe('src/core is provider-neutral', () => {
  const vocab = providerVocabulary(HARNESS_ROOT);

  it('the provider vocabulary is learned from the drivers (so this scan has terms to look for)', () => {
    expect(vocab.terms.length).toBeGreaterThan(0);
  });

  it('names no vendor error string and no provider term', () => {
    expect(vendorHits(join(HARNESS_ROOT, 'src', 'core'), vocab.terms)).toEqual([]);
  });

  it('the scan finds a vendor format planted in core-like code (it can fail)', () => {
    const dir = join(HARNESS_ROOT, '.harness', 'tmp', `core-neutral-${process.pid}-${Date.now()}`);
    mkdirSync(join(dir, 'nested'), { recursive: true });
    try {
      writeFileSync(join(dir, 'clean.ts'), 'export const retryDelaysMs = [1000];\nexport const status = 429;\n');
      writeFileSync(join(dir, 'nested', 'loop.ts'), 'if (/RESOURCE_EXHAUSTED/.test(m)) wait();\nconst reset = h["X-RateLimit-Reset"];\n');
      const hits = vendorHits(dir, vocab.terms);
      expect(hits).toEqual(['nested/loop.ts:1: RESOURCE_EXHAUSTED', 'nested/loop.ts:2: X-RateLimit']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
