/**
 * Line diff helpers for write tools: diff stats (+added -removed) and a
 * unified diff. A plain LCS table is enough for the file sizes an agent writes;
 * very large inputs fall back to a whole-file replace to stay bounded.
 */

export interface DiffStats {
  added: number;
  removed: number;
}

type Op = { kind: 'eq' | 'add' | 'del'; line: string; a: number; b: number };

/** Split text into lines; a trailing newline does not create an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const MAX_CELLS = 4_000_000;

function diffOps(a: string[], b: string[]): Op[] {
  // Trim common prefix/suffix first: cheap and keeps the LCS table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: 'eq', line: a[i] ?? '', a: i, b: i });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    midA.forEach((line, i) => ops.push({ kind: 'del', line, a: start + i, b: start }));
    midB.forEach((line, j) => ops.push({ kind: 'add', line, a: endA, b: start + j }));
  } else {
    // lcs[i][j] = LCS length of midA[i..] and midB[j..], flattened.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          midA[i] === midB[j]
            ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ kind: 'eq', line: midA[i] ?? '', a: start + i, b: start + j });
        i++;
        j++;
      } else if (i < n && (j >= m || (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) {
        // Deletions before additions on ties, as conventional unified diffs show them.
        ops.push({ kind: 'del', line: midA[i] ?? '', a: start + i, b: start + j });
        i++;
      } else {
        ops.push({ kind: 'add', line: midB[j] ?? '', a: start + i, b: start + j });
        j++;
      }
    }
  }
  const tailOffset = endB - endA;
  for (let i = endA; i < a.length; i++) ops.push({ kind: 'eq', line: a[i] ?? '', a: i, b: i + tailOffset });
  return ops;
}

export function diffStats(before: string, after: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const op of diffOps(splitLines(before), splitLines(after))) {
    if (op.kind === 'add') added++;
    else if (op.kind === 'del') removed++;
  }
  return { added, removed };
}

/** Unified diff with `context` lines around each hunk. Empty string when identical. */
export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  const ops = diffOps(splitLines(before ?? ''), splitLines(after));
  const changed = ops.map((op, idx) => (op.kind === 'eq' ? -1 : idx)).filter((idx) => idx >= 0);
  if (changed.length === 0) return '';

  // Group changed op indexes into hunks separated by more than 2*context equal lines.
  const hunks: Array<[number, number]> = [];
  for (const idx of changed) {
    const last = hunks[hunks.length - 1];
    if (last && idx - last[1] <= context * 2 + 1) last[1] = idx;
    else hunks.push([idx, idx]);
  }

  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
  for (const [first, lastIdx] of hunks) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, lastIdx + context);
    const slice = ops.slice(from, to + 1);
    const head = slice[0];
    if (!head) continue;
    const aCount = slice.filter((op) => op.kind !== 'add').length;
    const bCount = slice.filter((op) => op.kind !== 'del').length;
    const aStart = aCount === 0 ? head.a : head.a + 1;
    const bStart = bCount === 0 ? head.b : head.b + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice) {
      out.push(`${op.kind === 'eq' ? ' ' : op.kind === 'add' ? '+' : '-'}${op.line}`);
    }
  }
  return out.join('\n') + '\n';
}

/** Start offsets of every non-overlapping occurrence of `find` in `text`. */
export function occurrences(text: string, find: string): number[] {
  const at: number[] = [];
  if (find === '') return at;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) at.push(i);
  return at;
}

/** 1-based line number of a character offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Apply an exact single-occurrence replacement; null unless `find` occurs exactly once. */
export function applySingleEdit(text: string, find: string, replace: string): string | null {
  const at = occurrences(text, find);
  const first = at[0];
  if (at.length !== 1 || first === undefined) return null;
  return text.slice(0, first) + replace + text.slice(first + find.length);
}

/** `wrote/edited` style stat: `+a −b`. */
export function formatStats(s: DiffStats): string {
  return `+${s.added} −${s.removed}`;
}

/** `before` with `text` appended on its own line(s): the exact result of the append_file tool. */
export function appendText(before: string, text: string): string {
  if (before.length === 0) return text;
  return before.endsWith('\n') ? before + text : `${before}\n${text}`;
}

/**
 * The post-call content of the shipped write tools from their input: `content` replaces the file
 * (write_file), `append` is added on its own line(s) (append_file), `find`/`replace` replaces the
 * one exact occurrence (edit_file). undefined when it cannot be computed (unknown input shape, or an
 * edit that matches 0 or 2+ times). Internal to those tools' preview(): hooks judge
 * ToolCallInfo.preview, never input field names.
 */
export function proposedContent(input: unknown, before: string | null): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof rec[k] === 'string' ? (rec[k] as string) : undefined);
  const content = str('content');
  if (content !== undefined) return content;
  const append = str('append');
  if (append !== undefined) return appendText(before ?? '', append);
  const find = str('find');
  const replace = str('replace');
  if (find === undefined || replace === undefined || before === null) return undefined;
  return applySingleEdit(before, find, replace) ?? undefined;
}
