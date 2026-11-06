/**
 * `harness` (no command) and `harness chat`: the interactive session on the real terminal.
 * Options: --driver <name>, --model <id>, --max-turns N (per message), --driver-opt k=v (repeatable).
 */
import type { ParsedArgs } from '../core/cli.ts';
import { terminalInput } from './input.ts';
import { stripControls } from './sanitize.ts';
import { runSession } from './session.ts';
import type { Output } from './ui.ts';

const OPTIONS = new Set(['driver', 'model', 'max-turns', 'driver-opt', 'help']);

export async function runSessionCli(p: ParsedArgs, out: (line: string) => void): Promise<number> {
  const unknown = [...p.flags.keys(), ...p.bools].find((k) => !OPTIONS.has(k));
  if (unknown !== undefined || p.positionals.length > 0) {
    out(unknown !== undefined ? `unknown option --${unknown} (a session takes --driver, --model, --max-turns, --driver-opt)` : `a session takes no arguments, got: ${p.positionals.join(' ')}`);
    return 2;
  }
  const last = (k: string): string | undefined => p.flags.get(k)?.at(-1);
  const mt = last('max-turns');
  let maxTurns: number | undefined;
  if (mt !== undefined) {
    maxTurns = Number(mt);
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      out('--max-turns must be a positive integer (turns per message)');
      return 2;
    }
  }
  const options: Record<string, string> = {};
  for (const kv of p.flags.get('driver-opt') ?? []) {
    const i = kv.indexOf('=');
    if (i <= 0) {
      out(`--driver-opt expects k=v, got "${kv}"`);
      return 2;
    }
    options[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const stdout = process.stdout;
  const output: Output = {
    write: (t) => {
      stdout.write(t);
    },
    isTTY: stdout.isTTY === true,
    get columns() {
      return stdout.columns;
    },
  };
  const input = terminalInput({ notify: (text) => output.write(`\n${stripControls(text)}\n`) });
  try {
    const r = await runSession({
      cwd: process.cwd(),
      input,
      output,
      model: { driver: last('driver'), model: last('model'), options },
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    });
    return r.code;
  } finally {
    input.close();
  }
}
