/**
 * Claude driver (Anthropic Messages API, beta surface). All Anthropic wire formats live here.
 *
 * The core speaks the neutral Message/Part model; this file translates to and from
 * content blocks. Thinking / redacted_thinking / fallback blocks are carried through the
 * core as OpaquePart (driver 'claude') and replayed verbatim in their original position.
 *
 * Resilience: 429 / 529 / 5xx / connection errors are retried by the SDK (maxRetries 4); a rate
 * limit that outlasts them tells the loop its wait through retryAfterMs (_wire.ts).
 * A 400/403 that names one of the optional extras (betas, fallbacks, thinking block binding,
 * cache_control, output_config / effort, thinking) switches the session to a minimal
 * request on the plain endpoint (no betas, no fallbacks, no cache_control, no thinking
 * config, no replayed opaque blocks) and retries once; `model` then reads "<id> (compat)".
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaFallbackBlockParam,
  BetaMessage,
  BetaRedactedThinkingBlockParam,
  BetaThinkingBlockParam,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  ContentBlock,
  Message as PlainMessage,
  MessageCountTokensParams,
  MessageCreateParamsNonStreaming as PlainCreateParams,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { defineDriver } from '../../src/core/plugin-api.ts';
import type {
  Driver,
  DriverCreateOptions,
  Message,
  ModelRequest,
  ModelResponse,
  Part,
  StopReason,
  ToolSpec,
  Usage,
} from '../../src/core/plugin-api.ts';
import { errorInfo, isRecord, normalizeTranscript, outputTokenCeiling, rateLimitRetryAfterMs, toolSchema, type ObjectSchema } from './_wire.ts';

export const DRIVER_NAME = 'claude';
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_MAX_TOKENS = 16000;
export const BETAS = ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'];
/** SDK-level retries for 408/409/429/5xx (incl. 529 overloaded) and connection errors. */
export const MAX_RETRIES = 4;
/**
 * Explicit request timeout. Without one the SDK refuses (locally) any non-streaming request
 * whose max_tokens implies more than ten minutes of output (> ~21k tokens).
 */
export const TIMEOUT_MS = 15 * 60 * 1000;
export const COMPAT_SUFFIX = ' (compat)';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

// ───────────────────────────── client seam (injectable for tests) ─────────────────────────────

export interface RequestOpts {
  signal?: AbortSignal;
}

export interface ClaudeClient {
  beta: {
    messages: {
      create(params: MessageCreateParamsNonStreaming, options?: RequestOpts): PromiseLike<BetaMessage>;
    };
  };
  messages: {
    create(params: PlainCreateParams, options?: RequestOpts): PromiseLike<PlainMessage>;
    countTokens(params: MessageCountTokensParams): PromiseLike<{ input_tokens: number }>;
  };
}

export type ClaudeClientFactory = (apiKey: string) => ClaudeClient;

/** Options of the real SDK client. */
export const CLIENT_OPTIONS = { maxRetries: MAX_RETRIES, timeout: TIMEOUT_MS } as const;

const defaultFactory: ClaudeClientFactory = (apiKey) => new Anthropic({ apiKey, ...CLIENT_OPTIONS });

// ───────────────────────────── wire blocks ─────────────────────────────

interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
type PlainBlock = TextBlock | ToolUseBlock | ToolResultBlock;
type ReplayBlock = BetaThinkingBlockParam | BetaRedactedThinkingBlockParam | BetaFallbackBlockParam;
export type ClaudeBlock = PlainBlock | ReplayBlock;

export interface ClaudeWireMessage<B = ClaudeBlock> {
  role: 'user' | 'assistant';
  content: B[];
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: ObjectSchema;
}

function isFallbackInfo(v: unknown): v is { model: string } {
  return isRecord(v) && typeof v['model'] === 'string';
}

/** A stored opaque payload that may be sent back as-is. */
export function isReplayBlock(v: unknown): v is ReplayBlock {
  if (!isRecord(v)) return false;
  switch (v['type']) {
    case 'thinking':
      return typeof v['thinking'] === 'string' && typeof v['signature'] === 'string';
    case 'redacted_thinking':
      return typeof v['data'] === 'string';
    case 'fallback':
      return isFallbackInfo(v['from']) && isFallbackInfo(v['to']);
    default:
      return false;
  }
}

function ownReplayable(p: Part): boolean {
  return p.type !== 'opaque' || (p.driver === DRIVER_NAME && isReplayBlock(p.data));
}

function noOpaque(p: Part): boolean {
  return p.type !== 'opaque';
}

function plainBlock(p: Part): PlainBlock | null {
  switch (p.type) {
    case 'text':
      return { type: 'text', text: p.text };
    case 'tool_call':
      return { type: 'tool_use', id: p.id, name: p.name, input: isRecord(p.input) ? p.input : {} };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: p.callId, content: p.content, is_error: p.isError };
    case 'opaque':
      return null;
  }
}

function partToBlock(p: Part): ClaudeBlock | null {
  if (p.type === 'opaque') return isReplayBlock(p.data) ? p.data : null;
  return plainBlock(p);
}

/** Messages with no opaque blocks at all (minimal request and token counting). */
export function toPlainClaudeMessages(messages: Message[]): ClaudeWireMessage<PlainBlock>[] {
  return normalizeTranscript(messages, noOpaque).map((m) => ({
    role: m.role,
    content: m.parts.flatMap((p) => {
      const b = plainBlock(p);
      return b === null ? [] : [b];
    }),
  }));
}

/**
 * Neutral messages → Messages API messages (see normalizeTranscript for the invariants:
 * alternating roles, each tool_use answered by a tool_result in the next user turn with the
 * results first, no empty content, user first and last). Opaque parts are replayed only when
 * `includeOpaque` and only when they belong to this driver, in their original position.
 */
export function toClaudeMessages(messages: Message[], includeOpaque = true): ClaudeWireMessage[] {
  if (!includeOpaque) return toPlainClaudeMessages(messages);
  return normalizeTranscript(messages, ownReplayable).map((m) => ({
    role: m.role,
    content: m.parts.flatMap((p) => {
      const b = partToBlock(p);
      return b === null ? [] : [b];
    }),
  }));
}

export function toClaudeTools(tools: ToolSpec[]): ClaudeTool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: toolSchema(t.inputSchema) }));
}

/** Response content blocks → neutral parts. */
export function fromClaudeContent(content: ReadonlyArray<BetaContentBlock | ContentBlock>): Part[] {
  const parts: Part[] = [];
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text.length > 0) parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      parts.push({ type: 'tool_call', id: b.id, name: b.name, input: b.input });
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'fallback') {
      parts.push({ type: 'opaque', driver: DRIVER_NAME, data: b });
    }
  }
  return parts;
}

export function mapClaudeStop(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      // end_turn, stop_sequence, pause_turn, model_context_window_exceeded and anything new
      return 'end_turn';
  }
}

export function mapClaudeUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}): Usage {
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return { inputTokens: u.input_tokens + cacheRead + cacheWrite, outputTokens: u.output_tokens, cachedInputTokens: cacheRead };
}

export function fromClaudeResponse(msg: BetaMessage | PlainMessage): ModelResponse {
  const stop = mapClaudeStop(msg.stop_reason);
  // A refusal's content is not trustworthy as a turn: report the stop, keep no parts.
  const parts = stop === 'refusal' ? [] : fromClaudeContent(msg.content);
  return { parts, stop, usage: mapClaudeUsage(msg.usage), model: msg.model };
}

function maxTokens(req: ModelRequest, ceiling: number | undefined): number {
  const wanted = req.maxOutputTokens > 0 ? req.maxOutputTokens : DEFAULT_MAX_TOKENS;
  return ceiling === undefined ? wanted : Math.min(wanted, ceiling);
}

/** The full request (beta surface): fallbacks, adaptive thinking with block binding, effort, auto caching. */
export function buildClaudeParams(req: ModelRequest, model: string, effort: Effort, ceiling?: number): MessageCreateParamsNonStreaming {
  const params: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens(req, ceiling),
    messages: toClaudeMessages(req.messages, true),
    betas: BETAS,
    fallbacks: 'default',
    // The harness compacts older turns, so thinking blocks whose prefix changed are dropped, not a 400.
    thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    output_config: { effort },
    // Automatic prompt caching of the stable prefix.
    cache_control: { type: 'ephemeral' },
  };
  if (req.system.length > 0) params.system = req.system;
  if (req.tools.length > 0) {
    params.tools = toClaudeTools(req.tools);
    // Forced tool choice is rejected with adaptive thinking: always let the model decide.
    params.tool_choice = { type: 'auto' };
  }
  return params;
}

/** The minimal request (plain endpoint): no betas, fallbacks, cache_control, thinking config or replayed blocks. */
export function buildCompatParams(req: ModelRequest, model: string, ceiling?: number): PlainCreateParams {
  const params: PlainCreateParams = {
    model,
    max_tokens: maxTokens(req, ceiling),
    messages: toPlainClaudeMessages(req.messages),
  };
  if (req.system.length > 0) params.system = req.system;
  if (req.tools.length > 0) {
    params.tools = toClaudeTools(req.tools);
    params.tool_choice = { type: 'auto' };
  }
  return params;
}

/** Words that identify a rejection of one of the optional extras of the full request. */
const EXTRAS = /beta|fallback|block_binding|prefix_mismatch|cache_control|output_config|effort|thinking|adaptive|extra inputs are not permitted/i;

/** Whether an error is a rejection of an optional extra (→ downgrade to the minimal request). */
export function isExtrasRejection(e: unknown): boolean {
  const info = errorInfo(e);
  return (info.status === 400 || info.status === 403) && EXTRAS.test(info.text);
}

/** Output-token ceiling named by a 400 that rejected max_tokens, if any. */
function rejectedCeiling(e: unknown): number | undefined {
  const info = errorInfo(e);
  return info.status === 400 ? outputTokenCeiling(info.text) : undefined;
}

function parseEffort(v: string | undefined): Effort {
  const value = v ?? 'high';
  const hit = EFFORTS.find((e) => e === value);
  if (hit === undefined) throw new Error(`HARNESS_CLAUDE_EFFORT must be one of ${EFFORTS.join(', ')} (got "${value}")`);
  return hit;
}

export interface ClaudeDriver extends Driver {
  /** True once the session switched to the minimal request. */
  readonly compat: boolean;
}

export function createClaudeDriver(opts: DriverCreateOptions, factory: ClaudeClientFactory = defaultFactory): ClaudeDriver {
  const apiKey = opts.env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) throw new Error('ANTHROPIC_API_KEY is not set');
  const model = opts.model ?? opts.env['HARNESS_CLAUDE_MODEL'] ?? DEFAULT_MODEL;
  const effort = parseEffort(opts.env['HARNESS_CLAUDE_EFFORT']);
  const client = factory(apiKey);
  let compat = false;
  let ceiling: number | undefined;

  const send = async (req: ModelRequest, ro: RequestOpts | undefined): Promise<ModelResponse> => {
    if (compat) return fromClaudeResponse(await client.messages.create(buildCompatParams(req, model, ceiling), ro));
    return fromClaudeResponse(await client.beta.messages.create(buildClaudeParams(req, model, effort, ceiling), ro));
  };

  return {
    name: DRIVER_NAME,
    get model() {
      return compat ? `${model}${COMPAT_SUFFIX}` : model;
    },
    get compat() {
      return compat;
    },
    tokenCounter: 'anthropic messages.countTokens',
    async complete(req, signal) {
      const ro = signal === undefined ? undefined : { signal };
      // At most one max_tokens clamp and one downgrade per call; each retry changes the request.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await send(req, ro);
        } catch (e) {
          if (attempt >= 2) throw e;
          const cap = rejectedCeiling(e);
          if (cap !== undefined && (ceiling === undefined || cap < ceiling) && cap < maxTokens(req, ceiling)) {
            ceiling = cap;
            continue;
          }
          if (!compat && isExtrasRejection(e)) {
            compat = true;
            continue;
          }
          throw e;
        }
      }
    },
    async countTokens(req) {
      const params: MessageCountTokensParams = { model, messages: toPlainClaudeMessages(req.messages) };
      if (req.system.length > 0) params.system = req.system;
      if (req.tools.length > 0) params.tools = toClaudeTools(req.tools);
      const res = await client.messages.countTokens(params);
      return res.input_tokens;
    },
    retryAfterMs: (e) => rateLimitRetryAfterMs(e),
  };
}

export default defineDriver({
  name: DRIVER_NAME,
  description: 'Anthropic Messages API (adaptive thinking, server-side fallback, automatic prompt caching).',
  create: (opts) => createClaudeDriver(opts),
});
