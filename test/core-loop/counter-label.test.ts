import { describe, expect, it } from 'vitest';
import { TokenLedger } from '../../src/core/tokens.ts';

const meta = { runId: 'r', task: 't', driver: 'd', model: 'm', counter: 'provider countTokens', mode: 'jit' as const };
const row = { turn: 1, actual: 10, baseline: 100, providerInput: 10, providerCached: 0, output: 1, attribution: { frontLoadChars: 0, rawReturnChars: 0, historyChars: 0 } };

describe('token report counter label', () => {
  it('names the driver counter when every count came from it', () => {
    const l = new TokenLedger({ ...meta });
    l.record(row);
    expect(l.report().counter).toBe('provider countTokens');
  });

  it('never names a counter that did not produce the numbers', () => {
    const l = new TokenLedger({ ...meta });
    l.record(row);
    l.noteEstimated();
    l.noteEstimated();
    expect(l.report().counter).toBe('chars/4 estimate for 2 count(s): provider countTokens was unavailable');
    expect(l.counterLabel()).toBe(l.report().counter);
  });
});
