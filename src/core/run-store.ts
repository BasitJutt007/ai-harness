/**
 * Run evidence on disk: runs/<id>/{transcript.jsonl, events.jsonl, logs/, *.json}.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseTestBaseline } from './test-baseline.ts';
import type { LogStore, RunEvent, RunState, TestBaseline, TestObservation } from './types.ts';

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** `${taskId}-${driver}-${yyyymmdd}-${hhmmss}` (UTC). */
export function newRunId(taskId: string, driver: string, now: Date = new Date()): string {
  const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${taskId}-${driver}-${d}-${t}`;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s.length > 0 ? s : 'log';
}

/** Plain file name under the run dir: no separators, no "..". */
function safeName(name: string): string {
  if (name.length === 0 || name.includes('\0') || /[\\/]/.test(name) || name === '.' || name === '..') {
    throw new Error(`invalid run file name "${name}"`);
  }
  return name;
}

class RunLogs implements LogStore {
  private counter: number;
  constructor(
    private readonly dir: string,
    private readonly harnessRoot: string,
  ) {
    this.counter = 0;
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        const m = /^(\d+)-/.exec(f);
        if (m?.[1] !== undefined) this.counter = Math.max(this.counter, Number(m[1]));
      }
    }
  }
  async write(name: string, content: string): Promise<string> {
    mkdirSync(this.dir, { recursive: true });
    this.counter += 1;
    const file = join(this.dir, `${pad(this.counter, 3)}-${slugify(name.replace(/\.txt$/i, ''))}.txt`);
    await writeFile(file, content, 'utf8');
    return toPosix(relative(this.harnessRoot, file));
  }
}

export class RunStore {
  readonly logs: LogStore;
  readonly runDir: string;
  readonly harnessRoot: string;

  constructor(runDir: string, harnessRoot: string) {
    this.harnessRoot = resolve(harnessRoot);
    this.runDir = isAbsolute(runDir) ? runDir : resolve(this.harnessRoot, runDir);
    mkdirSync(this.runDir, { recursive: true });
    this.logs = new RunLogs(join(this.runDir, 'logs'), this.harnessRoot);
  }

  private path(name: string): string {
    return join(this.runDir, safeName(name));
  }

  appendTranscript(entry: unknown): void {
    appendFileSync(this.path('transcript.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  }

  appendEvent(e: RunEvent): void {
    appendFileSync(this.path('events.jsonl'), `${JSON.stringify(e)}\n`, 'utf8');
  }

  writeJson(name: string, value: unknown): void {
    writeFileSync(this.path(name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  writeText(name: string, value: string): void {
    writeFileSync(this.path(name), value, 'utf8');
  }

  readJson<T>(name: string): T | null {
    const file = this.path(name);
    if (!existsSync(file)) return null;
    try {
      // The caller asserts the shape of what it previously wrote.
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }
}

// ───────────────────────────── state (de)serialisation ─────────────────────────────

export interface SerializedState {
  turn: number;
  tests: TestObservation[];
  written: string[];
  initialHashes: Array<[string, string]>;
  testBaseline?: TestBaseline;
  plan: string[];
  events: RunEvent[];
  scratch: Array<[string, unknown]>;
  finishAttempts: number;
}

export function newRunState(): RunState {
  return {
    turn: 0,
    tests: [],
    written: new Set(),
    initialHashes: new Map(),
    plan: [],
    events: [],
    scratch: new Map(),
    finishAttempts: 0,
  };
}

/** Make scratch values JSON-safe (nested Sets/Maps become tagged objects). */
function encode(v: unknown): unknown {
  if (v instanceof Set) return { $set: [...v].map(encode) };
  if (v instanceof Map) return { $map: [...v.entries()].map(([k, x]) => [encode(k), encode(x)]) };
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = encode(x);
    return out;
  }
  return v;
}

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v);
    if (keys.length === 1 && '$set' in v && Array.isArray(v.$set)) return new Set(v.$set.map(decode));
    if (keys.length === 1 && '$map' in v && Array.isArray(v.$map)) {
      const m = new Map<unknown, unknown>();
      for (const pair of v.$map) {
        if (Array.isArray(pair) && pair.length === 2) m.set(decode(pair[0]), decode(pair[1]));
      }
      return m;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = decode(x);
    return out;
  }
  return v;
}

export function serializeState(s: RunState): SerializedState {
  return {
    turn: s.turn,
    tests: s.tests,
    written: [...s.written].sort(),
    initialHashes: [...s.initialHashes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    ...(s.testBaseline !== undefined ? { testBaseline: s.testBaseline } : {}),
    plan: s.plan,
    events: s.events,
    scratch: [...s.scratch.entries()].map(([k, v]) => [k, encode(v)]),
    finishAttempts: s.finishAttempts,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringPairs(v: unknown): Array<[string, string]> {
  if (Array.isArray(v)) {
    return v.filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string');
  }
  if (isRecord(v)) {
    return Object.entries(v).filter((p): p is [string, string] => typeof p[1] === 'string');
  }
  return [];
}

export function deserializeState(v: unknown): RunState {
  if (!isRecord(v)) throw new Error('run state is not an object');
  const s = newRunState();
  if (typeof v.turn === 'number') s.turn = v.turn;
  if (typeof v.finishAttempts === 'number') s.finishAttempts = v.finishAttempts;
  if (Array.isArray(v.tests)) s.tests = v.tests.filter(isRecord) as unknown as TestObservation[];
  if (Array.isArray(v.written)) s.written = new Set(v.written.filter((x): x is string => typeof x === 'string'));
  s.initialHashes = new Map(stringPairs(v.initialHashes));
  const baseline = parseTestBaseline(v.testBaseline);
  if (baseline !== undefined) s.testBaseline = baseline;
  if (Array.isArray(v.plan)) s.plan = v.plan.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(v.events)) s.events = v.events.filter(isRecord) as unknown as RunEvent[];
  if (Array.isArray(v.scratch)) {
    for (const pair of v.scratch) {
      if (Array.isArray(pair) && typeof pair[0] === 'string') s.scratch.set(pair[0], decode(pair[1]));
    }
  } else if (isRecord(v.scratch)) {
    for (const [k, x] of Object.entries(v.scratch)) s.scratch.set(k, decode(x));
  }
  return s;
}
