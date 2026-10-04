/**
 * The claude driver counts with the provider's count_tokens endpoint. When that fails, the loop
 * estimates BOTH counts of the turn with chars/4, and the token report (and so run.json's
 * tokenCounter, which run.ts takes from the same ledger.counterLabel()) names the fallback, never
 * the counter that did not produce the numbers. The provider-reported usage is still the provider's.
 */
import { describe, expect, it } from 'vitest';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { createClaudeDriver, type ClaudeClient } from '../../plugins/drivers/claude.ts';
import { runAgent } from '../../src/core/loop.ts';
import { TokenLedger } from '../../src/core/tokens.ts';
import { fakeCtx, fakeStore, finishTool, firstMessage, specs } from '../core-loop/fakes.ts';

function answer(): BetaMessage {
  return {
    id: 'msg_1',
    container: null,
    content: [{ type: 'text', text: 'ok', citations: null }],
    context_management: null,
    diagnostics: null,
    model: 'model-under-test',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: 321,
      iterations: null,
      output_tokens: 5,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

describe('claude driver: count_tokens unavailable', () => {
  for (const failing of ['every count', 'only the baseline count'] as const) {
    it(`${failing}: the turn is estimated on both sides and the counter label names the fallback`, async () => {
      let counts = 0;
      const client: ClaudeClient = {
        beta: { messages: { create: async () => answer() } },
        messages: {
          create: async () => Promise.reject(new Error('unused')),
          async countTokens(params) {
            counts += 1;
            const isBaseline = typeof params.system === 'string' && params.system.includes('FRONT-LOAD');
            if (failing === 'every count' || isBaseline) throw new Error('404 count_tokens is not available on this endpoint');
            return { input_tokens: 77 };
          },
        },
      };
      const driver = createClaudeDriver({ model: 'model-under-test', options: {}, env: { ANTHROPIC_API_KEY: 'k' }, harnessRoot: '/x' }, () => client);
      const tools = [finishTool()];
      const { ctx, logs } = fakeCtx({ tools });
      const ledger = new TokenLedger({ runId: 'r', task: 't', driver: driver.name, model: driver.model, counter: driver.tokenCounter, mode: 'jit' });
      await runAgent({ driver, ctx, store: fakeStore(logs), ledger, first: firstMessage(), system: 'S', baselineSystem: 'S FRONT-LOAD', tools: specs(tools), maxTurns: 1, maxOutputTokens: 100, retryDelaysMs: [] });
      const rep = ledger.report();
      expect(rep.counter).toBe(`chars/4 estimate for 2 count(s): ${driver.tokenCounter} was unavailable`);
      expect(ledger.counterLabel()).toBe(rep.counter); // what run.ts writes as run.json tokenCounter
      expect(rep.turns[0]?.estimated).toBe(true);
      expect(rep.turns[0]?.actual_input_tokens).not.toBe(77); // never a provider count mixed into an estimated turn
      expect(rep.turns[0]?.provider_reported_input_tokens).toBe(321);
      expect(rep.provider_usage).toBe('reported');
      expect(counts).toBe(failing === 'every count' ? 1 : 2);
    });
  }
});
