import { describe, expect, it } from 'vitest';
import { adjustShape, buildOpenAIParams, STANDARD_SHAPE } from '../../plugins/drivers/openai.ts';
import type { ModelRequest } from '../../src/core/plugin-api.ts';

// The real 400 the official endpoint returned for gpt-6-luna on Chat Completions with function tools.
const REAL_400 = Object.assign(new Error("400 Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."), {
  status: 400,
  error: { message: "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", type: 'invalid_request_error', param: 'reasoning_effort', code: null },
});

const req: ModelRequest = {
  system: 'sys',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'finish', description: 'Finish.', inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }],
  maxOutputTokens: 1000,
};

describe('openai driver: reasoning_effort compat (real gpt-6-luna 400)', () => {
  it('the standard request does not send reasoning_effort', () => {
    expect('reasoning_effort' in buildOpenAIParams(req, 'm')).toBe(false);
  });

  it("switches to reasoning_effort 'none' when the API asks for it, once", () => {
    const next = adjustShape(REAL_400, STANDARD_SHAPE, 1000);
    expect(next?.noReasoning).toBe(true);
    expect(buildOpenAIParams(req, 'm', next).reasoning_effort).toBe('none');
    // applied at most once: the same error does not loop
    expect(next === undefined ? undefined : adjustShape(REAL_400, next, 1000)).toBeUndefined();
  });

  it('does not react to unrelated 400s that mention reasoning', () => {
    const other = Object.assign(new Error('400 reasoning_effort must be one of low, medium, high'), { status: 400 });
    expect(adjustShape(other, STANDARD_SHAPE, 1000)?.noReasoning).not.toBe(true);
  });
});
