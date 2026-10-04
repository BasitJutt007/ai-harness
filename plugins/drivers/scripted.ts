/**
 * Scripted driver: an offline replay of a JSON script of tool calls.
 *
 * For the harness's own tests and for demos without API keys. It is never model
 * evidence: the model id is always reported as `scripted:<script>`.
 *
 *   --driver scripted --driver-opt script=fixtures/scripted/<name>.json
 *
 * Script format:
 *   { "description": string,
 *     "turns": [ { "text"?: string, "calls": [ { "name": string, "input": object, "contentFile"?: string } ] } ] }
 * `contentFile` is resolved relative to the script's directory; its text becomes `input.content`.
 * The N-th complete() call returns turn N (call ids `call_<N>_<i>`, N 1-based, i 0-based).
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineDriver } from '../../src/core/plugin-api.ts';
import type { Driver, DriverCreateOptions, ModelResponse, Part } from '../../src/core/plugin-api.ts';
import { countRequest } from '../lib/tokenize.ts';

export const DRIVER_NAME = 'scripted';

const CallSchema = z
  .object({
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    contentFile: z.string().min(1).optional(),
  })
  .strict();

const ScriptSchema = z
  .object({
    description: z.string(),
    turns: z.array(z.object({ text: z.string().optional(), calls: z.array(CallSchema) }).strict()),
  })
  .strict();

export interface ScriptedCall { name: string; input: Record<string, unknown> }
export interface ScriptedTurn { text?: string; calls: ScriptedCall[] }
export interface LoadedScript { description: string; file: string; turns: ScriptedTurn[] }

/** Read, validate and resolve a script file (contentFile → input.content). */
export function loadScript(file: string): LoadedScript {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`scripted driver: cannot read script ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = ScriptSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`scripted driver: invalid script ${file}: ${issues}`);
  }
  const dir = dirname(file);
  const turns = parsed.data.turns.map((t): ScriptedTurn => {
    const calls = t.calls.map((c): ScriptedCall => {
      if (c.contentFile === undefined) return { name: c.name, input: c.input };
      const contentPath = resolve(dir, c.contentFile);
      let content: string;
      try {
        content = readFileSync(contentPath, 'utf8');
      } catch (e) {
        throw new Error(`scripted driver: contentFile ${c.contentFile} (${contentPath}): ${e instanceof Error ? e.message : String(e)}`);
      }
      return { name: c.name, input: { ...c.input, content } };
    });
    return t.text === undefined ? { calls } : { text: t.text, calls };
  });
  return { description: parsed.data.description, file, turns };
}

export function createScriptedDriver(opts: DriverCreateOptions): Driver {
  const scriptOpt = opts.options['script'];
  if (scriptOpt === undefined || scriptOpt.length === 0) {
    throw new Error('scripted driver needs --driver-opt script=<path relative to the harness root>');
  }
  const file = isAbsolute(scriptOpt) ? scriptOpt : resolve(opts.harnessRoot, scriptOpt);
  const script = loadScript(file);
  const model = `scripted:${basename(file)}`;
  let calls = 0;
  return {
    name: DRIVER_NAME,
    model,
    tokenCounter: 'js-tiktoken o200k_base (scripted driver: estimate)',
    async complete(): Promise<ModelResponse> {
      calls += 1;
      const turn = script.turns[calls - 1];
      const parts: Part[] = [];
      if (turn === undefined) {
        parts.push({ type: 'text', text: 'script exhausted' });
      } else {
        if (turn.text !== undefined && turn.text.length > 0) parts.push({ type: 'text', text: turn.text });
        turn.calls.forEach((c, i) => parts.push({ type: 'tool_call', id: `call_${calls}_${i}`, name: c.name, input: c.input }));
      }
      const hasCalls = parts.some((p) => p.type === 'tool_call');
      return {
        parts,
        stop: hasCalls ? 'tool_calls' : 'end_turn',
        // No provider served this response: report no usage rather than a local estimate dressed as one.
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reported: false },
        model,
      };
    },
    async countTokens(req) {
      return countRequest(req);
    },
  };
}

export default defineDriver({
  name: DRIVER_NAME,
  description: 'Offline replay of a JSON script of tool calls (tests and key-less demos; never model evidence).',
  create: (opts) => createScriptedDriver(opts),
});
