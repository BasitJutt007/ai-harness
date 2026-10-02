/**
 * OpenAI driver (Chat Completions with function tools). All OpenAI wire formats live here.
 *
 * Token counting is local (js-tiktoken o200k_base) over the exact chat payload this
 * driver would send, with the standard chat-format per-message overhead.
 *
 * Resilience: 429 / 5xx / connection errors are retried by the SDK (maxRetries 4). A 400
 * that rejects one of our parameters is answered by changing only that parameter and
 * retrying (max_completion_tokens → max_tokens, an output-token ceiling, tool_choice dropped,
 * system → developer role, loose tool schemas); the change is kept for the session and
 * `model` then reads "<id> (compat)". When no model was chosen (flag / env), a model the
 * account cannot use falls back along DEFAULT_MODELS.
 */
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions';
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
import { MESSAGE_OVERHEAD, REPLY_PRIMING, countText } from '../lib/tokenize.ts';
import { errorInfo, normalizeTranscript, outputTokenCeiling, toolSchema } from './_wire.ts';

export const DRIVER_NAME = 'openai';
/**
 * Default model, then the fallbacks tried (only when no model was chosen) if the account
 * cannot use it. 'gpt-5.5' is the general model the installed SDK (openai 7.27.0) uses in
 * its own Chat Completions examples. Override with --model or HARNESS_OPENAI_MODEL.
 */
export const DEFAULT_MODEL = 'gpt-5.5';
export const DEFAULT_MODELS: readonly string[] = [DEFAULT_MODEL, 'gpt-5'];
export const DEFAULT_MAX_TOKENS = 16000;
export const MAX_RETRIES = 4;
export const COMPAT_SUFFIX = ' (compat)';

// ───────────────────────────── client seam (injectable for tests) ─────────────────────────────

export interface OpenAIClient {
  chat: {
    completions: {
      create(body: ChatCompletionCreateParamsNonStreaming, options?: { signal?: AbortSignal }): PromiseLike<ChatCompletion>;
    };
  };
}

export type OpenAIClientFactory = (apiKey: string) => OpenAIClient;

/** Options of the real SDK client. */
export const CLIENT_OPTIONS = { maxRetries: MAX_RETRIES } as const;

const defaultFactory: OpenAIClientFactory = (apiKey) => new OpenAI({ apiKey, ...CLIENT_OPTIONS });

// ───────────────────────────── request shape (session state) ─────────────────────────────

/** Request-shape adjustments learned from 400s; all false/undefined = the standard request. */
export interface OpenAIShape {
  /** Send `max_tokens` instead of `max_completion_tokens`. */
  legacyMaxTokens: boolean;
  /** Output-token ceiling named by the API. */
  ceiling: number | undefined;
  /** Omit `tool_choice` ('auto' is the default anyway). */
  omitToolChoice: boolean;
  /** Role of the instructions message. */
  systemRole: 'system' | 'developer';
  /** Keep only widely supported JSON Schema keywords in tool parameters. */
  looseSchemas: boolean;
}

export const STANDARD_SHAPE: OpenAIShape = { legacyMaxTokens: false, ceiling: undefined, omitToolChoice: false, systemRole: 'system', looseSchemas: false };

function isStandard(s: OpenAIShape): boolean {
  return !s.legacyMaxTokens && s.ceiling === undefined && !s.omitToolChoice && s.systemRole === 'system' && !s.looseSchemas;
}

// ───────────────────────────── translation ─────────────────────────────

function toolCallOf(p: Extract<Part, { type: 'tool_call' }>): ChatCompletionMessageFunctionToolCall {
  return { id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } };
}

function noOpaque(p: Part): boolean {
  return p.type !== 'opaque';
}

/**
 * System + neutral messages → chat messages. OpaquePart (any driver) is ignored. Every
 * assistant tool call is answered by a role:'tool' message before any other user content
 * (see normalizeTranscript for the invariants).
 */
export function toOpenAIMessages(system: string, messages: Message[], systemRole: OpenAIShape['systemRole'] = 'system'): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  if (system.length > 0) out.push(systemRole === 'developer' ? { role: 'developer', content: system } : { role: 'system', content: system });
  for (const m of normalizeTranscript(messages, noOpaque)) {
    const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
    if (m.role === 'assistant') {
      const calls = m.parts.flatMap((p) => (p.type === 'tool_call' ? [toolCallOf(p)] : []));
      out.push(calls.length > 0 ? { role: 'assistant', content: text.length > 0 ? text : null, tool_calls: calls } : { role: 'assistant', content: text });
      continue;
    }
    for (const p of m.parts) {
      if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.callId, content: p.content });
    }
    if (text.length > 0) out.push({ role: 'user', content: text });
  }
  return out;
}

export function toOpenAITools(tools: ToolSpec[], loose = false): ChatCompletionFunctionTool[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toolSchema(t.inputSchema, loose) } }));
}

/** Parse function-call arguments; invalid JSON becomes `{ __invalid_json: raw }` so core validation rejects it with feedback. */
export function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json: raw };
  }
}

export function mapOpenAIStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export function mapOpenAIUsage(u: ChatCompletion['usage']): Usage {
  if (u === undefined) return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0 };
}

export function fromOpenAIResponse(res: ChatCompletion): ModelResponse {
  const choice = res.choices[0];
  const usage = mapOpenAIUsage(res.usage);
  if (choice === undefined) return { parts: [], stop: 'error', usage, model: res.model };
  const parts: Part[] = [];
  const msg = choice.message;
  if (typeof msg.content === 'string' && msg.content.length > 0) parts.push({ type: 'text', text: msg.content });
  for (const call of msg.tool_calls ?? []) {
    if (call.type !== 'function') continue;
    parts.push({ type: 'tool_call', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
  }
  let stop = mapOpenAIStop(choice.finish_reason);
  if (typeof msg.refusal === 'string' && msg.refusal.length > 0) stop = 'refusal';
  // Some models report "stop" while still returning tool calls; the calls are authoritative.
  if (stop === 'end_turn' && parts.some((p) => p.type === 'tool_call')) stop = 'tool_calls';
  return { parts, stop, usage, model: res.model };
}

export function buildOpenAIParams(req: ModelRequest, model: string, shape: OpenAIShape = STANDARD_SHAPE): ChatCompletionCreateParamsNonStreaming {
  const wanted = req.maxOutputTokens > 0 ? req.maxOutputTokens : DEFAULT_MAX_TOKENS;
  const limit = shape.ceiling === undefined ? wanted : Math.min(wanted, shape.ceiling);
  const params: ChatCompletionCreateParamsNonStreaming = { model, messages: toOpenAIMessages(req.system, req.messages, shape.systemRole) };
  if (shape.legacyMaxTokens) params.max_tokens = limit;
  else params.max_completion_tokens = limit;
  if (req.tools.length > 0) {
    params.tools = toOpenAITools(req.tools, shape.looseSchemas);
    if (!shape.omitToolChoice) params.tool_choice = 'auto';
  }
  return params;
}

/**
 * The adjusted shape for a 400 that rejected part of the request, or undefined when the
 * error is not about anything we can change. Each adjustment applies at most once.
 */
export function adjustShape(e: unknown, shape: OpenAIShape, maxOutputTokens: number): OpenAIShape | undefined {
  const info = errorInfo(e);
  if (info.status !== 400) return undefined;
  const t = info.text;
  const cap = outputTokenCeiling(t);
  const current = shape.ceiling ?? (maxOutputTokens > 0 ? maxOutputTokens : DEFAULT_MAX_TOKENS);
  if (cap !== undefined && cap < current) return { ...shape, ceiling: cap };
  if (!shape.legacyMaxTokens && /max_completion_tokens/.test(t)) return { ...shape, legacyMaxTokens: true };
  if (!shape.omitToolChoice && /tool_choice/.test(t)) return { ...shape, omitToolChoice: true };
  if (shape.systemRole === 'system' && /'system'|"system"|role.{0,40}system|system.{0,40}role/i.test(t)) return { ...shape, systemRole: 'developer' };
  if (!shape.looseSchemas && /schema|parameters|tools\[/i.test(t)) return { ...shape, looseSchemas: true };
  return undefined;
}

/** A rejection meaning the account cannot use this model on this endpoint. */
export function isModelUnavailable(e: unknown): boolean {
  const info = errorInfo(e);
  return info.code === 'model_not_found' || (info.status === 404 && /model/i.test(info.text));
}

/** Text a chat message contributes to the prompt (every string field, tool calls as JSON). */
function messageText(m: ChatCompletionMessageParam): string {
  const pieces: string[] = [m.role];
  const content = m.content;
  if (typeof content === 'string') pieces.push(content);
  else if (Array.isArray(content)) pieces.push(JSON.stringify(content));
  if (m.role === 'tool') pieces.push(m.tool_call_id);
  if (m.role === 'assistant' && m.tool_calls !== undefined) pieces.push(JSON.stringify(m.tool_calls));
  return pieces.join('\n');
}

/** Local count of the exact chat payload: 3 per message + 3 reply priming + tool definitions JSON. */
export function countChatPayload(params: Pick<ChatCompletionCreateParamsNonStreaming, 'messages' | 'tools'>): number {
  let total = REPLY_PRIMING;
  for (const m of params.messages) total += MESSAGE_OVERHEAD + countText(messageText(m));
  if (params.tools !== undefined && params.tools.length > 0) total += countText(JSON.stringify(params.tools));
  return total;
}

export interface OpenAIDriver extends Driver {
  /** Current request-shape adjustments. */
  readonly shape: OpenAIShape;
}

export function createOpenAIDriver(opts: DriverCreateOptions, factory: OpenAIClientFactory = defaultFactory): OpenAIDriver {
  const apiKey = opts.env['OPENAI_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) throw new Error('OPENAI_API_KEY is not set');
  const chosen = opts.model ?? opts.env['HARNESS_OPENAI_MODEL'];
  const candidates: string[] = chosen !== undefined && chosen.length > 0 ? [chosen] : [...DEFAULT_MODELS];
  const client = factory(apiKey);
  let modelIdx = 0;
  let shape: OpenAIShape = STANDARD_SHAPE;
  const current = (): string => candidates[modelIdx] ?? DEFAULT_MODEL;

  return {
    name: DRIVER_NAME,
    get model() {
      return isStandard(shape) ? current() : `${current()}${COMPAT_SUFFIX}`;
    },
    get shape() {
      return shape;
    },
    tokenCounter: 'js-tiktoken o200k_base (local, OpenAI chat format)',
    async complete(req, signal) {
      const ro = signal === undefined ? undefined : { signal };
      // Bounded: each retry follows a strictly new adjustment or the next model candidate.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return fromOpenAIResponse(await client.chat.completions.create(buildOpenAIParams(req, current(), shape), ro));
        } catch (e) {
          if (attempt >= 8) throw e;
          if (isModelUnavailable(e) && modelIdx + 1 < candidates.length) {
            modelIdx += 1;
            continue;
          }
          const next = adjustShape(e, shape, req.maxOutputTokens);
          if (next === undefined) throw e;
          shape = next;
        }
      }
    },
    async countTokens(req) {
      return countChatPayload(buildOpenAIParams(req, current(), shape));
    },
  };
}

export default defineDriver({
  name: DRIVER_NAME,
  description: 'OpenAI Chat Completions with function tools (local o200k_base token counting).',
  create: (opts) => createOpenAIDriver(opts),
});
