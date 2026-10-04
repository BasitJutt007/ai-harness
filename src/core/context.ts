/**
 * Context views over ONE canonical transcript.
 *
 * jitView      what the model actually sees (with compactHistory):
 *              - every tool_call input string longer than ELIDE_INPUT_CHARS is elided from
 *                the first replay on: the payload is on disk (or was refused, which the
 *                result says) and the tool result already summarises it;
 *              - the last `keepRecentTurns` turns stay as structured messages (compact tool
 *                summaries, verbatim assistant text);
 *              - older turns fold into a digest appended to the first user message: one
 *                line per tool call (`t<turn> <tool> <short input> -> <first line of result>`,
 *                input strings longer than DIGEST_VALUE_CHARS shown as `<N chars>`), assistant
 *                prose and opaque parts dropped with their turn;
 *              - after the digest, a working set: a skeleton (signature lines with line
 *                numbers) of each file read in a folded turn and not written since, so a file's
 *                shape does not vanish from context the moment its read turn ages out;
 *              - a repeat pointer (see repeatPointer) whose referenced turn has folded is shown
 *                with the full content it pointed to again.
 * baselineView the baseline history: raw tool returns everywhere, nothing elided or folded
 *              (the shadow baseline also leaves out the run's context-fetch calls: a
 *              baseline harness has that content front-loaded and offers no fetchers).
 *
 * Both rules are pure functions of (turn index, number of turns) and append-only: input
 * elision never changes after the first replay, and the digest only ever gains lines at
 * its end. So the serialized request prefix (system, tools, brief, digest so far) is stable
 * from turn to turn, which keeps provider-side prompt caching effective.
 */
import { posix } from 'node:path';
import type { Message, Part, ToolCallPart, ToolPlugin, ToolResultPart, ToolSpec } from './types.ts';

export interface TranscriptTurn {
  turn: number;
  /** As returned by the driver. */
  assistant: Message;
  /** User message with tool_result parts (compact content in JIT mode), or a nudge, or null. */
  results: Message | null;
  /** callId -> raw tool output (for the baseline view). */
  raw: Record<string, string>;
  /** callId -> where the full content of a result answered with a repeat pointer lives. */
  repeats?: Record<string, RepeatRef>;
  /**
   * callId -> canonical API-relative paths a successful write call touched (as the workspace
   * resolved them: `src//a.ts`, `src/./a.ts`, an absolute path or another letter case all land
   * on `src/a.ts`). The working set tracks staleness through these, not the raw input path.
   */
  written?: Record<string, string[]>;
}

/**
 * A read result the loop answered with a pointer instead of a second copy: `turn` is the turn
 * the pointer names (visible when the pointer was made), `source` the call whose result holds
 * the full, byte-identical content.
 */
export interface RepeatRef {
  turn: number;
  source: { turn: number; callId: string };
}

/** Model-visible content of a read whose result is byte-identical to one still in context. */
export function repeatPointer(tool: string, turn: number): string {
  return `unchanged since t${turn}: identical to that ${tool} result, still in your context above`;
}

/** Digest lines quote at most this many characters of a result's first line. */
export const MAX_STUB_CHARS = 200;
/** Tool-call input strings longer than this are elided in the JIT view. */
export const ELIDE_INPUT_CHARS = 300;
/**
 * Digest lines show input strings up to this length (paths, patterns, rule ids, plan steps);
 * longer ones (file contents, edit find/replace text) become `<N chars>`: the result line
 * already says what the call did, and the payload is on disk.
 */
export const DIGEST_VALUE_CHARS = 80;

/**
 * Placeholder for an elided input string. The path (when any) stays visible in the same
 * input object, and the system prompt says once that large inputs are omitted.
 */
export function omitted(n: number): string {
  return `<omitted ${n} chars>`;
}

/** Digest placeholder for an input string longer than DIGEST_VALUE_CHARS (`content=<800 chars>`). */
export function elided(n: number): string {
  return `<${n} chars>`;
}

/** Tail line of a skeleton that left signature lines out. */
export function moreSignatureLines(n: number): string {
  return `… ${n} more signature lines`;
}

/**
 * Every placeholder the context views render in place of content the model no longer sees
 * (input elision, digest values, skeleton tails, repeat pointers), as ONE regex built from the
 * renderers themselves, so it follows any change to their wording. None of them is ever file
 * content: the elision guard refuses a write whose post-image gains one. No flags (stateless):
 * add 'g' on a copy to find every occurrence.
 */
export const ELISION_PLACEHOLDER: RegExp = placeholderRegex();

function placeholderRegex(): RegExp {
  const N = 9_876_543_210;
  const TOOL = 'tool_sentinel_x';
  const forms = [omitted(N), elided(N), moreSignatureLines(N), repeatPointer(TOOL, N)].map((s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(String(N)).join('\\d+').split(TOOL).join('[\\w-]+'),
  );
  return new RegExp(forms.map((f) => `(?:${f})`).join('|'));
}

/** Tool-call input with every string longer than ELIDE_INPUT_CHARS replaced by a placeholder. */
export function compactToolInput(v: unknown): unknown {
  if (typeof v === 'string') return v.length > ELIDE_INPUT_CHARS ? omitted(v.length) : v;
  if (Array.isArray(v)) return v.map(compactToolInput);
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = compactToolInput(x);
    return out;
  }
  return v;
}

/** Digest rendering of one input value: bare when it is a single token, `<N chars>` when long. */
function digestValue(x: unknown): string {
  if (typeof x === 'string') {
    if (x.length > DIGEST_VALUE_CHARS) return elided(x.length);
    return /^[^\s"[\]{},=<>]+$/.test(x) ? x : JSON.stringify(x);
  }
  if (Array.isArray(x)) return `[${x.map(digestValue).join(',')}]`;
  if (typeof x === 'object' && x !== null) {
    return `{${Object.entries(x).map(([k, v]) => `${k}:${digestValue(v)}`).join(',')}}`;
  }
  return JSON.stringify(x) ?? String(x);
}

/** Short `key=value` rendering of a tool input for the digest (long strings as `<N chars>`). */
export function digestInput(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input === undefined ? '' : digestValue(input);
  return Object.entries(input)
    .map(([k, x]) => `${k}=${digestValue(x)}`)
    .join(' ');
}

function elideCalls(m: Message): Message {
  if (!m.parts.some((p) => p.type === 'tool_call')) return m;
  return { role: m.role, parts: m.parts.map((p) => (p.type === 'tool_call' ? { ...p, input: compactToolInput(p.input) } : p)) };
}

/** Opening line of the history digest (explains the format once, instead of per stub). */
export const DIGEST_HEADER = 'Earlier turns, one line per tool call (tool, short input, first line of its result; re-run a tool to see more):';

/** First line of a result that carries text (skips blank and rule-only lines), capped. */
export function headline(s: string): string {
  const line = (s.split('\n').find((l) => /[\p{L}\p{N}]/u.test(l)) ?? '').trim().replace(/\s+/g, ' ');
  return line.length > MAX_STUB_CHARS ? `${line.slice(0, MAX_STUB_CHARS)}…` : line;
}

/** Digest lines for one turn: deterministic, depends on that turn only. */
export function digestTurn(t: TranscriptTurn): string[] {
  const results = new Map<string, string>();
  for (const p of t.results?.parts ?? []) if (p.type === 'tool_result') results.set(p.callId, p.content);
  const lines: string[] = [];
  for (const p of t.assistant.parts) {
    if (p.type !== 'tool_call') continue;
    const input = digestInput(p.input);
    const result = results.get(p.id);
    lines.push(`t${t.turn} ${p.name}${input === '' ? '' : ` ${input}`} -> ${result === undefined ? '(no result)' : headline(result)}`);
  }
  if (lines.length === 0) lines.push(`t${t.turn} (no tool call)`);
  return lines;
}

// ───────────────────────────── working set ─────────────────────────────

/** Read tools whose results feed the working set. */
const WORKING_SET_READS: ReadonlySet<string> = new Set(['read_file', 'outline']);
/** Write tools assumed when the caller names none (the loop passes every offered write-effect tool). */
export const DEFAULT_WRITE_TOOLS: readonly string[] = ['write_file', 'edit_file', 'append_file'];
/** Character budget of the working set (most recently read first). */
export const WORKING_SET_CHARS = 12_000;
/**
 * Of that budget, how much may be FULL read results (most recent first); older entries are
 * skeletons. Real runs: a model editing three related files re-read them in a 3-turn cycle when
 * only skeletons survived (it needs to see the bodies side by side to reason about an edit).
 */
export const WORKING_SET_FULL_CHARS = 6_000;
/** A folded read stays in full only this many turns after it left the kept recent turns. */
export const WORKING_SET_FULL_TURNS = 3;
/** Signature lines kept per file skeleton. */
export const SKELETON_LINES = 40;
export const WORKING_SET_HEADER =
  'Files you read in earlier turns and have not written since (most recent first: the latest read in full while space allows, then signature lines with their line numbers; read_file a line range for a body):';

/**
 * API-relative path named by a tool input (`path`), normalised like the path policy does for a
 * relative path (backslashes, `//`, `./`, `a/../`), without a leading `./` or `/`. A fallback only:
 * write calls carry their canonical paths in TranscriptTurn.written.
 */
function inputPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const v = (input as Record<string, unknown>)['path'];
  if (typeof v !== 'string') return null;
  return posix.normalize(v.trim().replace(/\\/g, '/')).replace(/^(\.\/|\/)+/, '').replace(/\/+$/, '');
}

const SIGNATURE = /^(export\b|import\b|(async\s+)?function\b|class\b|const\b|let\b|type\b|interface\b|enum\b|describe\(|it\(|test\(|\w+\.(get|post|put|patch|delete|use)\()/;

/**
 * Skeleton of a numbered file listing (`<n>| <code>` lines, as read_file returns): its header
 * line plus the top-level signature lines (imports, exports, declarations, top-level test
 * titles, route registrations) with their line numbers. Nested lines (bodies) are left out.
 */
export function skeleton(listing: string, maxLines = SKELETON_LINES): string {
  // A CRLF file keeps a trailing \r on every listed line (read_file splits on \n): drop it.
  const lines = listing.split('\n').map((l) => l.replace(/\r$/, ''));
  const keep: string[] = [];
  for (const l of lines.slice(1)) {
    const code = /^\s*\d+\| (.*)$/.exec(l)?.[1];
    if (code === undefined || /^\s/.test(code) || !SIGNATURE.test(code)) continue;
    keep.push(l.length > 160 ? `${l.slice(0, 160)}…` : l);
  }
  const shown = keep.slice(0, maxLines);
  if (keep.length > shown.length) shown.push(moreSignatureLines(keep.length - shown.length));
  return [lines[0] ?? '', ...shown].join('\n');
}

/** Full content of a result: the result itself, or for a repeat pointer the result it points to. */
function resolvedContent(turns: TranscriptTurn[], t: TranscriptTurn, p: ToolResultPart): string {
  const ref = t.repeats?.[p.callId];
  if (ref === undefined) return p.content;
  const src = turns.find((x) => x.turn === ref.source.turn)?.results?.parts.find((x) => x.type === 'tool_result' && x.callId === ref.source.callId);
  return src !== undefined && src.type === 'tool_result' ? src.content : p.content;
}

/**
 * Working set for a view that folds `turns[0..cutoff)` into the digest: for each file whose
 * latest successful read_file / outline sits in a folded turn, that read, most recently read
 * first: in full while it left the recent turns at most WORKING_SET_FULL_TURNS turns ago and
 * WORKING_SET_FULL_CHARS allows, otherwise as a skeleton (an outline as is), all within WORKING_SET_CHARS. A file read again in the
 * kept recent turns (successfully: a failed re-read shows nothing) is visible there and left out.
 * Staleness is tracked through write-tool calls only (any call to one of `writeTools` touching
 * the path, in any later turn or later in the same turn, drops it; the path is the canonical one
 * the loop recorded in `written`, else the normalised input path); a file changed some other way
 * (e.g. by code run during run_tests) keeps its entry. The skeleton is a hint with line numbers, not the file: the model can re-read.
 * Pure function of the transcript, deterministic.
 */
export function workingSet(
  turns: TranscriptTurn[],
  cutoff: number,
  writeTools: Iterable<string> = DEFAULT_WRITE_TOOLS,
  fullChars: number = WORKING_SET_FULL_CHARS,
): string | null {
  const writes = new Set(writeTools);
  const lastWrite = new Map<string, number>();
  const recentReads = new Set<string>();
  const seqOf = new Map<ToolCallPart, number>();
  let seq = 0;
  turns.forEach((t, i) => {
    const results = resultMap(t);
    for (const p of t.assistant.parts) {
      if (p.type !== 'tool_call') continue;
      seq += 1;
      seqOf.set(p, seq);
      if (writes.has(p.name)) {
        const canonical = t.written?.[p.id];
        const fallback = inputPath(p.input);
        for (const path of canonical ?? (fallback !== null ? [fallback] : [])) lastWrite.set(path, seq);
      } else if (i >= cutoff && WORKING_SET_READS.has(p.name)) {
        // Only a successful recent read shows the file: a failed one (a bad range) must not hide its skeleton.
        const r = results.get(p.id);
        const path = r === undefined || r.isError ? null : readPath(p, r);
        if (path !== null) recentReads.add(path);
      }
    }
  });
  const picked = new Map<string, { full: string | null; skel: string }>();
  for (let i = cutoff - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t === undefined) continue;
    const results = resultMap(t);
    for (const p of [...t.assistant.parts].reverse()) {
      if (p.type !== 'tool_call' || !WORKING_SET_READS.has(p.name)) continue;
      const r = results.get(p.id);
      const path = readPath(p, r);
      if (path === null || r === undefined || r.isError || picked.has(path) || recentReads.has(path)) continue;
      if ((lastWrite.get(path) ?? -1) > (seqOf.get(p) ?? 0)) continue;
      const content = resolvedContent(turns, t, r);
      const recent = cutoff - 1 - i < WORKING_SET_FULL_TURNS;
      picked.set(path, { full: recent ? content : null, skel: p.name === 'read_file' ? skeleton(content) : content });
    }
  }
  const blocks: string[] = [];
  let used = 0;
  let fullUsed = 0;
  for (const e of picked.values()) {
    const useFull = e.full !== null && fullUsed + e.full.length <= fullChars && used + e.full.length <= WORKING_SET_CHARS;
    const b = useFull && e.full !== null ? e.full : e.skel;
    if (used + b.length > WORKING_SET_CHARS) continue;
    blocks.push(b);
    used += b.length;
    if (useFull) fullUsed += b.length;
  }
  return blocks.length === 0 ? null : [WORKING_SET_HEADER, ...blocks].join('\n');
}

function resultMap(t: TranscriptTurn): Map<string, ToolResultPart> {
  const out = new Map<string, ToolResultPart>();
  for (const p of t.results?.parts ?? []) if (p.type === 'tool_result') out.set(p.callId, p);
  return out;
}

/** The path a read reported in its header line (`src/a.ts (lines 1-9 of 9)` / `src/a.ts (9 lines)`), else its input path. */
function readPath(call: ToolCallPart, result: ToolResultPart | undefined): string | null {
  const head = result !== undefined && !result.isError ? /^(\S+) \((?:lines \d+-\d+ of \d+|\d+ lines|empty file)\)/.exec(result.content)?.[1] : undefined;
  return head ?? inputPath(call.input);
}

/** Options of jitView. */
export interface JitViewOptions {
  /** Tools whose calls make earlier reads of the same path stale (default DEFAULT_WRITE_TOOLS). */
  writeTools?: Iterable<string>;
  /** Budget of FULL read results in the working set (default WORKING_SET_FULL_CHARS; 0 = skeletons only). */
  workingSetFullChars?: number;
}

export function jitView(
  first: Message,
  turns: TranscriptTurn[],
  keepRecentTurns: number,
  compactHistory: boolean,
  opts: JitViewOptions = {},
): Message[] {
  if (!compactHistory) {
    const out: Message[] = [first];
    for (const t of turns) {
      out.push(t.assistant);
      if (t.results !== null) out.push(t.results);
    }
    return out;
  }
  const cutoff = Math.max(0, turns.length - Math.max(0, keepRecentTurns));
  const digest = turns.slice(0, cutoff).flatMap(digestTurn);
  const extra: Part[] = [];
  // The digest comes first and only grows at its end; the working set follows it.
  if (digest.length > 0) extra.push({ type: 'text', text: [DIGEST_HEADER, ...digest].join('\n') });
  const ws = workingSet(turns, cutoff, opts.writeTools, opts.workingSetFullChars);
  if (ws !== null) extra.push({ type: 'text', text: ws });
  const head: Message = extra.length === 0 ? first : { role: first.role, parts: [...first.parts, ...extra] };
  const out: Message[] = [head];
  const firstKept = turns[cutoff]?.turn ?? Number.POSITIVE_INFINITY;
  for (const t of turns.slice(cutoff)) {
    out.push(elideCalls(t.assistant));
    if (t.results !== null) out.push(expandFoldedRepeats(turns, t, t.results, firstKept));
  }
  return out;
}

/** A repeat pointer whose named turn has folded into the digest points at nothing visible: show the full content again. */
function expandFoldedRepeats(turns: TranscriptTurn[], t: TranscriptTurn, results: Message, firstKept: number): Message {
  const repeats = t.repeats;
  if (repeats === undefined || !results.parts.some((p) => p.type === 'tool_result' && (repeats[p.callId]?.turn ?? firstKept) < firstKept)) return results;
  return {
    role: results.role,
    parts: results.parts.map((p) => (p.type === 'tool_result' && (repeats[p.callId]?.turn ?? firstKept) < firstKept ? { ...p, content: resolvedContent(turns, t, p) } : p)),
  };
}

// ───────────────────────────── baseline ─────────────────────────────

/**
 * A tool that fetches context (files, listings, search hits, standards text): the tool's own
 * `fetcher` flag when it declares one, else every `read` tool. Decided by effect and flag, never
 * by name, so a dropped-in read tool counts too.
 */
export function isContextFetcher(t: Pick<ToolPlugin<unknown>, 'effect' | 'fetcher'>): boolean {
  return t.fetcher ?? t.effect === 'read';
}

/** Names of the offered tools whose plugin is a context fetcher. */
export function fetcherNames(specs: ToolSpec[], plugins: Iterable<ToolPlugin<unknown>>): Set<string> {
  const offered = new Set(specs.map((s) => s.name));
  const out = new Set<string>();
  for (const p of plugins) if (offered.has(p.name) && isContextFetcher(p)) out.add(p.name);
  return out;
}

/** The baseline request's tools: `specs` without the context fetchers, order kept. */
export function withoutFetchers(specs: ToolSpec[], plugins: Iterable<ToolPlugin<unknown>>): ToolSpec[] {
  const fetchers = fetcherNames(specs, plugins);
  return specs.filter((s) => !fetchers.has(s.name));
}

/** Options of baselineView. */
export interface BaselineViewOptions {
  /** Tool names whose calls (and their results) are left out (the shadow baseline: the context fetchers). */
  omitTools?: ReadonlySet<string>;
}

/**
 * Baseline history: the same assistant turns verbatim, every tool result replaced by its raw
 * return, nothing elided or folded. Calls to `omitTools` are left out together with their results;
 * a message left empty is dropped.
 */
export function baselineView(first: Message, turns: TranscriptTurn[], opts: BaselineViewOptions = {}): Message[] {
  const omit = opts.omitTools ?? new Set<string>();
  const out: Message[] = [first];
  for (const t of turns) {
    const dropped = new Set<string>();
    for (const p of t.assistant.parts) if (p.type === 'tool_call' && omit.has(p.name)) dropped.add(p.id);
    if (dropped.size === 0) out.push(t.assistant);
    else {
      const parts = t.assistant.parts.filter((p) => p.type !== 'tool_call' || !dropped.has(p.id));
      if (parts.length > 0) out.push({ role: t.assistant.role, parts });
    }
    if (t.results === null) continue;
    const parts = t.results.parts.flatMap((p): Part[] => {
      if (p.type !== 'tool_result') return [p];
      if (dropped.has(p.callId)) return [];
      const raw = t.raw[p.callId];
      return [raw === undefined ? p : { ...p, content: raw }];
    });
    if (parts.length > 0) out.push({ role: t.results.role, parts });
  }
  return out;
}

function partChars(p: Part): number {
  switch (p.type) {
    case 'text':
      return p.text.length;
    case 'tool_call':
      return p.name.length + (JSON.stringify(p.input) ?? '').length;
    case 'tool_result':
      return p.content.length;
    case 'opaque':
      return (JSON.stringify(p.data) ?? '').length;
  }
}

/** Character footprint of a message list (used for the attribution of savings). */
export function messageChars(messages: Message[]): number {
  let n = 0;
  for (const m of messages) for (const p of m.parts) n += partChars(p);
  return n;
}
