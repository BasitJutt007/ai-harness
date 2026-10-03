/**
 * In-process fake provider endpoints for the live-shape suite. Each one is a `fetch`
 * implementation handed to the REAL installed SDK client, so everything above the HTTP
 * layer (SDK request building, beta header/query handling, JSON serialization, response
 * parsing, error classes) runs exactly as in production. No network is used.
 *
 * Every incoming request is validated against the provider's documented wire rules; a
 * request that breaks one is answered with a 400 and recorded in `rejections`, so a test
 * only has to assert that `rejections` is empty. Responses replay a neutral trajectory
 * (thinking + text + tool calls per turn) in the provider's own response shape.
 */

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FakeCall {
  name: string;
  input: Record<string, unknown>;
}

export interface FakeTurn {
  thinking: string;
  text?: string;
  calls: FakeCall[];
}

export interface WireRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: Record<string, unknown>;
}

export interface Rejection {
  path: string;
  problems: string[];
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'request-id': `req_${Math.random().toString(36).slice(2, 10)}`, ...headers } });
}

async function readRequest(input: string | URL | Request, init?: RequestInit): Promise<WireRequest> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  let text = '';
  if (typeof init?.body === 'string') text = init.body;
  else if (init?.body instanceof Uint8Array) text = new TextDecoder().decode(init.body);
  else if (input instanceof Request) text = await input.text();
  let parsed: unknown = {};
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { __unparseable: text.slice(0, 200) };
  }
  return { method, url, headers, body: isRecord(parsed) ? parsed : { __not_an_object: parsed } };
}

function headerRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = k === 'x-api-key' || k === 'authorization' ? '<redacted>' : v;
  });
  return out;
}

const approxTokens = (v: unknown): number => Math.max(1, Math.ceil(JSON.stringify(v).length / 4));

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function unknownKeys(o: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): string[] {
  return Object.keys(o).filter((k) => !allowed.has(k)).map((k) => `${where}.${k}: Extra inputs are not permitted`);
}

function rootCombinators(schema: Record<string, unknown>, where: string): string[] {
  return ['anyOf', 'oneOf', 'allOf'].filter((k) => k in schema).map((k) => `${where}: ${k} is not supported at the top level of a tool schema`);
}

// ───────────────────────────── Messages API (Claude) ─────────────────────────────

export const CLAUDE_EXPECTED_BETAS = { fallbacks: 'server-side-fallback-2026-07-01', blockBinding: 'thinking-binding-controls-2026-08-01' } as const;

const CLAUDE_CREATE_KEYS = new Set([
  'model', 'max_tokens', 'messages', 'system', 'tools', 'tool_choice', 'thinking', 'output_config', 'cache_control',
  'metadata', 'stop_sequences', 'temperature', 'top_p', 'top_k', 'service_tier', 'stream',
]);
const CLAUDE_BETA_ONLY_KEYS = new Set(['fallbacks', 'context_management', 'container', 'mcp_servers']);
const CLAUDE_COUNT_KEYS = new Set(['model', 'messages', 'system', 'tools', 'tool_choice', 'thinking', 'output_config', 'cache_control']);
const CLAUDE_TOOL_KEYS = new Set(['name', 'description', 'input_schema', 'cache_control', 'type']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function claudeTools(tools: unknown): { problems: string[]; names: Set<string> } {
  const problems: string[] = [];
  const names = new Set<string>();
  if (tools === undefined) return { problems, names };
  if (!Array.isArray(tools)) return { problems: ['tools: must be an array'], names };
  tools.forEach((t: unknown, i) => {
    const w = `tools.${i}`;
    if (!isRecord(t)) {
      problems.push(`${w}: must be an object`);
      return;
    }
    problems.push(...unknownKeys(t, CLAUDE_TOOL_KEYS, w));
    const name = t['name'];
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) problems.push(`${w}.name: must match ${TOOL_NAME.source}`);
    else if (names.has(name)) problems.push(`${w}.name: tool names must be unique (${name})`);
    else names.add(name);
    if (typeof t['description'] !== 'string' || t['description'].length === 0) problems.push(`${w}.description: required non-empty string`);
    const s = t['input_schema'];
    if (!isRecord(s)) problems.push(`${w}.input_schema: Field required`);
    else {
      if (s['type'] !== 'object') problems.push(`${w}.input_schema.type: Input should be 'object'`);
      if ('properties' in s && !isRecord(s['properties'])) problems.push(`${w}.input_schema.properties: must be an object`);
      problems.push(...rootCombinators(s, `${w}.input_schema`));
    }
  });
  return { problems, names };
}

/**
 * Messages-array rules of the Messages API: user first, strict alternation, user last,
 * non-empty content and non-whitespace text, blocks only in the role that may carry them,
 * every tool_use answered by a tool_result (results first) in the very next user message
 * and no result for an unknown id, unique tool_use ids, tools named in the request, and
 * thinking blocks only when thinking is on, replayed verbatim (signature ↔ text), with the
 * final tool-using assistant turn starting with its thinking block.
 */
function claudeMessages(messages: unknown, toolNames: Set<string>, thinkingOn: boolean, issued: ReadonlyMap<string, string>): string[] {
  const p: string[] = [];
  if (!Array.isArray(messages) || messages.length === 0) return ['messages: at least one message is required'];
  const seenIds = new Set<string>();
  let pending: string[] = [];
  let lastAssistantWithTools = -1;
  messages.forEach((m: unknown, i) => {
    const w = `messages.${i}`;
    if (!isRecord(m)) {
      p.push(`${w}: must be an object`);
      return;
    }
    const role = m['role'];
    if (role !== 'user' && role !== 'assistant') p.push(`${w}.role: must be user or assistant`);
    const want = i % 2 === 0 ? 'user' : 'assistant';
    if (role !== want) p.push(`${w}: roles must alternate starting with user (got ${String(role)})`);
    const content = m['content'];
    const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (blocks.length === 0) p.push(`${w}: all messages must have non-empty content`);
    const answered: string[] = [];
    let sawNonResult = false;
    const uses: string[] = [];
    blocks.forEach((b: unknown, j) => {
      const bw = `${w}.content.${j}`;
      if (!isRecord(b)) {
        p.push(`${bw}: must be an object`);
        return;
      }
      switch (b['type']) {
        case 'text':
          if (typeof b['text'] !== 'string' || b['text'].trim().length === 0) p.push(`${bw}: text content blocks must contain non-whitespace text`);
          if (role === 'user') sawNonResult = true;
          break;
        case 'tool_use': {
          if (role !== 'assistant') p.push(`${bw}: tool_use is only allowed in assistant messages`);
          const id = b['id'];
          if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) p.push(`${bw}.id: invalid tool_use id`);
          else if (seenIds.has(id)) p.push(`${bw}.id: tool_use ids must be unique (${id})`);
          else {
            seenIds.add(id);
            uses.push(id);
          }
          if (typeof b['name'] !== 'string' || !toolNames.has(b['name'])) p.push(`${bw}.name: tool ${String(b['name'])} is not in tools`);
          if (!isRecord(b['input'])) p.push(`${bw}.input: Input should be a valid dictionary`);
          break;
        }
        case 'tool_result': {
          if (role !== 'user') p.push(`${bw}: tool_result is only allowed in user messages`);
          if (sawNonResult) p.push(`${bw}: tool_result blocks must come first in the user message`);
          const id = b['tool_use_id'];
          if (typeof id !== 'string') p.push(`${bw}.tool_use_id: Field required`);
          else if (!pending.includes(id)) p.push(`${bw}: unexpected tool_use_id found in tool_result blocks: ${id}. Each tool_result block must have a corresponding tool_use block in the previous message.`);
          else if (answered.includes(id)) p.push(`${bw}: duplicate tool_result for ${id}`);
          else answered.push(id);
          const c = b['content'];
          if (!(typeof c === 'string' || Array.isArray(c))) p.push(`${bw}.content: must be a string or an array`);
          if ('is_error' in b && typeof b['is_error'] !== 'boolean') p.push(`${bw}.is_error: must be a boolean`);
          break;
        }
        case 'thinking': {
          if (role !== 'assistant') p.push(`${bw}: thinking is only allowed in assistant messages`);
          if (!thinkingOn) p.push(`${bw}: thinking blocks sent while thinking is not enabled`);
          const sig = b['signature'];
          const text = b['thinking'];
          if (typeof sig !== 'string' || typeof text !== 'string') p.push(`${bw}: thinking blocks need thinking and signature strings`);
          else if (issued.get(sig) !== text) p.push(`${bw}: Invalid signature in thinking block (not replayed verbatim)`);
          break;
        }
        case 'redacted_thinking':
          if (role !== 'assistant') p.push(`${bw}: redacted_thinking is only allowed in assistant messages`);
          if (typeof b['data'] !== 'string') p.push(`${bw}.data: Field required`);
          break;
        default:
          p.push(`${bw}.type: unsupported block type ${String(b['type'])}`);
      }
    });
    if (role === 'user') {
      const missing = pending.filter((id) => !answered.includes(id));
      if (missing.length > 0) p.push(`${w}: tool_use ids were found without tool_result blocks immediately after: ${missing.join(', ')}. Each tool_use block must have a corresponding tool_result block in the next message.`);
      pending = [];
    } else {
      pending = uses;
      if (uses.length > 0) lastAssistantWithTools = i;
    }
  });
  if (pending.length > 0) p.push(`messages: the last tool_use blocks (${pending.join(', ')}) have no tool_result`);
  const last = messages[messages.length - 1];
  if (isRecord(last) && last['role'] !== 'user') p.push('messages: the final message must be a user message (no assistant prefill with thinking)');
  if (thinkingOn && lastAssistantWithTools >= 0 && lastAssistantWithTools === messages.length - 2) {
    const m = messages[lastAssistantWithTools];
    const first: unknown = isRecord(m) && Array.isArray(m['content']) ? m['content'][0] : undefined;
    if (!isRecord(first) || (first['type'] !== 'thinking' && first['type'] !== 'redacted_thinking')) {
      p.push(`messages.${lastAssistantWithTools}.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`${isRecord(first) ? String(first['type']) : 'nothing'}\`. When thinking is enabled, a final assistant message must start with a thinking block.`);
    }
  }
  return p;
}

function claudeHeaders(req: WireRequest): string[] {
  const p: string[] = [];
  if (req.headers.get('x-api-key') !== 'test') p.push('header x-api-key: missing or wrong');
  if (req.headers.get('anthropic-version') !== '2023-06-01') p.push(`header anthropic-version: expected 2023-06-01, got ${String(req.headers.get('anthropic-version'))}`);
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) p.push('header content-type: expected application/json');
  return p;
}

function betaList(req: WireRequest): string[] {
  return (req.headers.get('anthropic-beta') ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function validateClaudeCreate(req: WireRequest, issued: ReadonlyMap<string, string>): string[] {
  const b = req.body;
  const betas = betaList(req);
  const betaEndpoint = req.url.searchParams.get('beta') === 'true';
  const p = [...claudeHeaders(req)];
  const allowed = new Set([...CLAUDE_CREATE_KEYS, ...(betaEndpoint ? CLAUDE_BETA_ONLY_KEYS : [])]);
  p.push(...unknownKeys(b, allowed, 'body'));
  if ('betas' in b) p.push('body.betas: betas belong in the anthropic-beta header');
  if (betas.length > 0 && !betaEndpoint) p.push('anthropic-beta header sent to the non-beta endpoint');
  if (typeof b['model'] !== 'string' || b['model'].length === 0) p.push('model: Field required');
  const maxTokens = b['max_tokens'];
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000) p.push('max_tokens: required integer in [1, 128000]');
  if ('fallbacks' in b && !betas.includes(CLAUDE_EXPECTED_BETAS.fallbacks)) p.push(`fallbacks: requires the ${CLAUDE_EXPECTED_BETAS.fallbacks} beta`);
  const thinking = b['thinking'];
  if (thinking !== undefined) {
    if (!isRecord(thinking) || !['adaptive', 'enabled', 'disabled'].includes(String(thinking['type']))) p.push('thinking.type: must be adaptive, enabled or disabled');
    else {
      if ('block_binding' in thinking && !betas.includes(CLAUDE_EXPECTED_BETAS.blockBinding)) p.push(`thinking.block_binding: requires the ${CLAUDE_EXPECTED_BETAS.blockBinding} beta`);
      const bb = thinking['block_binding'];
      if (bb !== undefined && (!isRecord(bb) || !['drop_block', 'error'].includes(String(bb['prefix_mismatch_behavior'])))) p.push('thinking.block_binding.prefix_mismatch_behavior: invalid');
      if (thinking['type'] === 'enabled' && !(typeof thinking['budget_tokens'] === 'number' && typeof maxTokens === 'number' && thinking['budget_tokens'] < maxTokens)) p.push('thinking.budget_tokens: must be < max_tokens');
    }
  }
  const oc = b['output_config'];
  if (oc !== undefined && (!isRecord(oc) || !EFFORTS.has(String(oc['effort'])))) p.push('output_config.effort: invalid');
  const cc = b['cache_control'];
  if (cc !== undefined && (!isRecord(cc) || cc['type'] !== 'ephemeral')) p.push('cache_control.type: must be ephemeral');
  const sys = b['system'];
  if (sys !== undefined && !(typeof sys === 'string' && sys.length > 0) && !Array.isArray(sys)) p.push('system: must be a non-empty string or an array of text blocks');
  const tools = claudeTools(b['tools']);
  p.push(...tools.problems);
  const tc = b['tool_choice'];
  if (tc !== undefined) {
    if (!isRecord(tc) || !['auto', 'any', 'tool', 'none'].includes(String(tc['type']))) p.push('tool_choice.type: invalid');
    else if (thinkingOn(b) && (tc['type'] === 'any' || tc['type'] === 'tool')) p.push('tool_choice: forced tool use is not compatible with thinking');
    if (b['tools'] === undefined) p.push('tool_choice: requires tools');
  }
  p.push(...claudeMessages(b['messages'], tools.names, thinkingOn(b), issued));
  return p;
}

function thinkingOn(b: Record<string, unknown>): boolean {
  const t = b['thinking'];
  return isRecord(t) && t['type'] !== 'disabled';
}

export function validateClaudeCount(req: WireRequest, issued: ReadonlyMap<string, string>): string[] {
  const b = req.body;
  const p = [...claudeHeaders(req)];
  p.push(...unknownKeys(b, CLAUDE_COUNT_KEYS, 'body'));
  if (typeof b['model'] !== 'string' || b['model'].length === 0) p.push('model: Field required');
  const tools = claudeTools(b['tools']);
  p.push(...tools.problems);
  p.push(...claudeMessages(b['messages'], tools.names, thinkingOn(b), issued));
  return p;
}

export interface FakeClaudeOptions {
  /** Answer one messages.create with this 400 invalid_request_error message (once). */
  rejectFirstWith?: string;
  /** The 1-based turn whose first create attempt gets that 400 (default 1). */
  rejectAtTurn?: number;
}

export interface FakeEndpoint {
  fetch: FetchFn;
  /** Every request received, in order. */
  requests: WireRequest[];
  /** Requests the validators refused (must stay empty). */
  rejections: Rejection[];
  /** Successful completions served (one per trajectory turn consumed). */
  served(): number;
  /** Requests answered with the injected 400. */
  injected: WireRequest[];
}

export interface FakeClaude extends FakeEndpoint {
  /** input_tokens returned by count_tokens, in order. */
  counted: number[];
  /** Total input tokens (input + cache read + cache write) reported per completion, in order. */
  reportedInput: number[];
  /** Signature → thinking text of every thinking block issued. */
  issued: Map<string, string>;
}

export function fakeClaude(turns: FakeTurn[], opts: FakeClaudeOptions = {}): FakeClaude {
  const requests: WireRequest[] = [];
  const rejections: Rejection[] = [];
  const injected: WireRequest[] = [];
  const counted: number[] = [];
  const reportedInput: number[] = [];
  const issued = new Map<string, string>();
  let served = 0;
  let rejectPending = opts.rejectFirstWith;

  const reject = (req: WireRequest, problems: string[]): Response => {
    rejections.push({ path: `${req.method} ${req.url.pathname}${req.url.search}`, problems, body: req.body, headers: headerRecord(req.headers) });
    return json(400, { type: 'error', error: { type: 'invalid_request_error', message: problems.join('; ') } });
  };

  const fetch: FetchFn = async (input, init) => {
    const req = await readRequest(input, init);
    requests.push(req);
    if (req.method !== 'POST') return reject(req, [`unexpected method ${req.method}`]);
    if (req.url.pathname === '/v1/messages/count_tokens') {
      const problems = validateClaudeCount(req, issued);
      if (problems.length > 0) return reject(req, problems);
      const n = approxTokens({ s: req.body['system'], m: req.body['messages'], t: req.body['tools'] });
      counted.push(n);
      return json(200, { input_tokens: n });
    }
    if (req.url.pathname !== '/v1/messages') return json(404, { type: 'error', error: { type: 'not_found_error', message: `no route ${req.url.pathname}` } });
    if (rejectPending !== undefined && served + 1 === (opts.rejectAtTurn ?? 1)) {
      const message = rejectPending;
      rejectPending = undefined;
      injected.push(req);
      return json(400, { type: 'error', error: { type: 'invalid_request_error', message } });
    }
    const problems = validateClaudeCreate(req, issued);
    if (problems.length > 0) return reject(req, problems);

    served += 1;
    const turn = turns[served - 1];
    const withThinking = thinkingOn(req.body);
    const content: Record<string, unknown>[] = [];
    if (withThinking) {
      const signature = `EqQBCkgIARABGAIiQ${served}${Math.random().toString(36).slice(2, 12)}`;
      const thinking = turn?.thinking ?? 'Nothing left to do.';
      issued.set(signature, thinking);
      content.push({ type: 'thinking', thinking, signature });
    }
    if (turn === undefined) content.push({ type: 'text', text: 'Trajectory exhausted.' });
    else {
      if (turn.text !== undefined) content.push({ type: 'text', text: turn.text });
      turn.calls.forEach((c, i) => content.push({ type: 'tool_use', id: `toolu_${String(served).padStart(2, '0')}${i}${Math.random().toString(36).slice(2, 10)}`, name: c.name, input: c.input }));
    }
    const total = approxTokens({ s: req.body['system'], m: req.body['messages'], t: req.body['tools'] });
    const cacheRead = served === 1 ? 0 : Math.floor(total * 0.6);
    const cacheWrite = Math.floor((total - cacheRead) / 2);
    reportedInput.push(total);
    const hasCalls = turn !== undefined && turn.calls.length > 0;
    return json(200, {
      id: `msg_${served}`,
      type: 'message',
      role: 'assistant',
      model: req.body['model'],
      content,
      stop_reason: hasCalls ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: total - cacheRead - cacheWrite,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 },
        output_tokens: 40 + 10 * (turn?.calls.length ?? 0),
        service_tier: 'standard',
      },
    });
  };

  return { fetch, requests, rejections, injected, counted, reportedInput, issued, served: () => served };
}

// ───────────────────────────── Chat Completions (OpenAI) ─────────────────────────────

const OPENAI_BODY_KEYS = new Set([
  'model', 'messages', 'tools', 'tool_choice', 'max_completion_tokens', 'max_tokens', 'parallel_tool_calls',
  'reasoning_effort', 'temperature', 'top_p', 'stop', 'store', 'metadata', 'user', 'seed', 'n', 'stream', 'response_format',
]);
const OPENAI_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

function openaiTools(tools: unknown): { problems: string[]; names: Set<string> } {
  const problems: string[] = [];
  const names = new Set<string>();
  if (tools === undefined) return { problems, names };
  if (!Array.isArray(tools) || tools.length === 0) return { problems: ['tools: must be a non-empty array'], names };
  tools.forEach((t: unknown, i) => {
    const w = `tools[${i}]`;
    if (!isRecord(t) || t['type'] !== 'function' || !isRecord(t['function'])) {
      problems.push(`${w}: expected {type:'function', function:{...}}`);
      return;
    }
    problems.push(...unknownKeys(t, new Set(['type', 'function']), w));
    const f = t['function'];
    problems.push(...unknownKeys(f, new Set(['name', 'description', 'parameters', 'strict']), `${w}.function`));
    const name = f['name'];
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) problems.push(`${w}.function.name: must match ${TOOL_NAME.source}`);
    else if (names.has(name)) problems.push(`${w}.function.name: duplicate ${name}`);
    else names.add(name);
    if (typeof f['description'] !== 'string') problems.push(`${w}.function.description: must be a string`);
    const params = f['parameters'];
    if (!isRecord(params)) problems.push(`${w}.function.parameters: required object`);
    else {
      if (params['type'] !== 'object') problems.push(`Invalid schema for function '${String(name)}': schema must be a JSON Schema of 'type: "object"'`);
      if ('properties' in params && !isRecord(params['properties'])) problems.push(`${w}.function.parameters.properties: must be an object`);
      problems.push(...rootCombinators(params, `${w}.function.parameters`));
    }
  });
  return { problems, names };
}

function openaiMessages(messages: unknown, toolNames: Set<string>): string[] {
  const p: string[] = [];
  if (!Array.isArray(messages) || messages.length === 0) return ["messages: '[]' is too short"];
  const first: unknown = messages[0];
  if (!isRecord(first) || (first['role'] !== 'system' && first['role'] !== 'developer')) p.push('messages[0]: expected the system/developer instructions first');
  let pending: string[] = [];
  let sawUser = false;
  const seenIds = new Set<string>();
  messages.forEach((m: unknown, i) => {
    const w = `messages[${i}]`;
    if (!isRecord(m)) {
      p.push(`${w}: must be an object`);
      return;
    }
    const role = m['role'];
    if (typeof role !== 'string' || !OPENAI_ROLES.has(role)) {
      p.push(`${w}.role: invalid ${String(role)}`);
      return;
    }
    if (role !== 'tool' && pending.length > 0) {
      p.push(`${w}: An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${pending.join(', ')}`);
      pending = [];
    }
    const content = m['content'];
    switch (role) {
      case 'system':
      case 'developer':
        if (typeof content !== 'string' || content.length === 0) p.push(`${w}.content: non-empty string required`);
        if (i !== 0) p.push(`${w}: instructions are expected only as the first message`);
        break;
      case 'user':
        sawUser = true;
        if (!(typeof content === 'string' && content.length > 0) && !(Array.isArray(content) && content.length > 0)) p.push(`${w}.content: non-empty content required`);
        break;
      case 'assistant': {
        const calls = m['tool_calls'];
        if (calls !== undefined) {
          if (!Array.isArray(calls) || calls.length === 0) p.push(`${w}.tool_calls: '[]' is too short`);
          else {
            const ids: string[] = [];
            calls.forEach((c: unknown, j) => {
              const cw = `${w}.tool_calls[${j}]`;
              if (!isRecord(c) || c['type'] !== 'function' || !isRecord(c['function']) || typeof c['id'] !== 'string') {
                p.push(`${cw}: expected {id, type:'function', function:{name, arguments}}`);
                return;
              }
              if (seenIds.has(c['id'])) p.push(`${cw}.id: duplicate ${c['id']}`);
              seenIds.add(c['id']);
              ids.push(c['id']);
              const f = c['function'];
              if (typeof f['name'] !== 'string' || !toolNames.has(f['name'])) p.push(`${cw}.function.name: ${String(f['name'])} is not in tools`);
              const args = f['arguments'];
              if (typeof args !== 'string') p.push(`${cw}.function.arguments: must be a JSON string`);
              else {
                try {
                  const parsed: unknown = JSON.parse(args);
                  if (!isRecord(parsed)) p.push(`${cw}.function.arguments: must encode an object`);
                } catch {
                  p.push(`${cw}.function.arguments: invalid JSON`);
                }
              }
            });
            pending = ids;
          }
          if (content !== null && typeof content !== 'string') p.push(`${w}.content: must be a string or null`);
        } else if (typeof content !== 'string' || content.length === 0) {
          p.push(`${w}.content: an assistant message without tool_calls needs content`);
        }
        break;
      }
      case 'tool': {
        const id = m['tool_call_id'];
        if (typeof id !== 'string' || !pending.includes(id)) {
          p.push(`${w}: messages with role 'tool' must be a response to a preceeding message with 'tool_calls' (tool_call_id ${String(id)})`);
        } else pending = pending.filter((x) => x !== id);
        if (typeof content !== 'string') p.push(`${w}.content: must be a string`);
        break;
      }
    }
  });
  if (pending.length > 0) p.push(`messages: tool_call_ids without a tool response: ${pending.join(', ')}`);
  if (!sawUser) p.push('messages: no user message');
  return p;
}

export interface FakeOpenAIOptions {
  /** Answer the first request with a 400 unsupported_parameter for max_completion_tokens (once); afterwards that parameter is refused. */
  rejectMaxCompletionTokens?: boolean;
  /**
   * Behave like an OpenAI-compatible gateway with thinking signatures: the first tool call of
   * every response carries an `extra_content` field, and a later request that replays that call
   * without the identical field is answered 400 ("missing a thought_signature").
   */
  signToolCalls?: boolean;
}

export interface FakeOpenAI extends FakeEndpoint {
  /** prompt_tokens reported per completion, in order. */
  reportedInput: number[];
  /** signToolCalls: call id -> the extra_content issued with it (JSON). */
  signed: Map<string, string>;
}

/** signToolCalls rule: every replayed call that was issued with an extra field carries it unchanged. */
function missingSignatures(body: Record<string, unknown>, signed: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  messages.forEach((m: unknown, i) => {
    if (!isRecord(m) || m['role'] !== 'assistant' || !Array.isArray(m['tool_calls'])) return;
    m['tool_calls'].forEach((c: unknown, j) => {
      if (!isRecord(c) || typeof c['id'] !== 'string') return;
      const want = signed.get(c['id']);
      if (want !== undefined && JSON.stringify(c['extra_content'] ?? null) !== want) {
        problems.push(`messages.${i}.tool_calls.${j}: Function call is missing a thought_signature (${c['id']})`);
      }
    });
  });
  return problems;
}

export function validateOpenAIChat(req: WireRequest, opts: { legacyOnly: boolean }): string[] {
  const b = req.body;
  const p: string[] = [];
  if (req.headers.get('authorization') !== 'Bearer test') p.push('header authorization: expected Bearer test');
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) p.push('header content-type: expected application/json');
  p.push(...unknownKeys(b, OPENAI_BODY_KEYS, 'body'));
  if (typeof b['model'] !== 'string' || b['model'].length === 0) p.push("model: you must provide a model parameter");
  const mct = b['max_completion_tokens'];
  const mt = b['max_tokens'];
  if (mct !== undefined && mt !== undefined) p.push('max_tokens and max_completion_tokens are mutually exclusive');
  if (mct === undefined && mt === undefined) p.push('expected an output-token limit (max_completion_tokens)');
  if (opts.legacyOnly && mct !== undefined) p.push("Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead.");
  for (const [k, v] of [['max_completion_tokens', mct], ['max_tokens', mt]] as const) {
    if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v > 0)) p.push(`${k}: must be a positive integer`);
  }
  const tools = openaiTools(b['tools']);
  p.push(...tools.problems);
  const tc = b['tool_choice'];
  if (tc !== undefined) {
    if (b['tools'] === undefined) p.push("tool_choice: 'tool_choice' is only allowed when 'tools' are specified");
    if (!(tc === 'auto' || tc === 'none' || tc === 'required' || isRecord(tc))) p.push('tool_choice: invalid');
  }
  p.push(...openaiMessages(b['messages'], tools.names));
  return p;
}

export function fakeOpenAI(turns: FakeTurn[], opts: FakeOpenAIOptions = {}): FakeOpenAI {
  const requests: WireRequest[] = [];
  const rejections: Rejection[] = [];
  const injected: WireRequest[] = [];
  const reportedInput: number[] = [];
  const signed = new Map<string, string>();
  let served = 0;
  let rejectPending = opts.rejectMaxCompletionTokens === true;
  const legacyOnly = opts.rejectMaxCompletionTokens === true;

  const reject = (req: WireRequest, problems: string[]): Response => {
    rejections.push({ path: `${req.method} ${req.url.pathname}`, problems, body: req.body, headers: headerRecord(req.headers) });
    return json(400, { error: { message: problems.join('; '), type: 'invalid_request_error', param: null, code: null } });
  };

  const fetch: FetchFn = async (input, init) => {
    const req = await readRequest(input, init);
    requests.push(req);
    if (req.method !== 'POST' || req.url.pathname !== '/v1/chat/completions') {
      return json(404, { error: { message: `Unknown request URL: ${req.method} ${req.url.pathname}`, type: 'invalid_request_error', param: null, code: 'unknown_url' } });
    }
    if (rejectPending && 'max_completion_tokens' in req.body) {
      rejectPending = false;
      injected.push(req);
      return json(400, {
        error: {
          message: "Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead.",
          type: 'invalid_request_error',
          param: 'max_completion_tokens',
          code: 'unsupported_parameter',
        },
      });
    }
    const problems = [...validateOpenAIChat(req, { legacyOnly }), ...(opts.signToolCalls === true ? missingSignatures(req.body, signed) : [])];
    if (problems.length > 0) return reject(req, problems);

    served += 1;
    const turn = turns[served - 1];
    const calls = (turn?.calls ?? []).map((c, i) => {
      const id = `call_${served}${i}${Math.random().toString(36).slice(2, 14)}`;
      const call = { id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } };
      if (opts.signToolCalls !== true || i > 0) return call;
      const extra = { gateway: { thought_signature: `sig_${id}_${'s'.repeat(40)}` } };
      signed.set(id, JSON.stringify(extra));
      return { ...call, extra_content: extra };
    });
    const text = turn === undefined ? 'Trajectory exhausted.' : (turn.text ?? null);
    const prompt = approxTokens({ m: req.body['messages'], t: req.body['tools'] });
    reportedInput.push(prompt);
    const completion = 30 + 10 * calls.length;
    return json(200, {
      id: `chatcmpl-${served}`,
      object: 'chat.completion',
      created: 1_790_000_000 + served,
      model: `${String(req.body['model'])}-2026-08-07`,
      system_fingerprint: 'fp_fake',
      service_tier: 'default',
      choices: [
        {
          index: 0,
          finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
          logprobs: null,
          message: { role: 'assistant', content: text, refusal: null, annotations: [], ...(calls.length > 0 ? { tool_calls: calls } : {}) },
        },
      ],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: { cached_tokens: served === 1 ? 0 : Math.floor(prompt / 2), audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 12, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      },
    });
  };

  return { fetch, requests, rejections, injected, reportedInput, signed, served: () => served };
}
