/**
 * secret-guard (pre, write): refuses content that looks like a credential
 * (prefixed API keys, cloud keys, tokens, PEM private keys, hard-coded api keys).
 * Edits are judged by the file they would produce, so a key split across several
 * small edits is caught on the edit that completes it.
 */
import { defineHook } from '../../src/core/plugin-api.ts';
import { applySingleEdit } from '../lib/diff.ts';
import { stringField, toApiRel } from '../lib/path-policy.ts';
import { formatSecretMatches, newSecrets, scanSecrets } from '../lib/secrets.ts';
import type { SecretMatch } from '../lib/secrets.ts';

export default defineHook({
  name: 'secret-guard',
  description: 'Blocks writes whose content contains key-like secrets.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    const where = call.paths[0] ?? call.tool;
    const r = call.paths[0] !== undefined ? toApiRel(ctx.workspace, call.paths[0]) : null;
    const before = r !== null && r.ok ? await ctx.workspace.read(r.rel) : null;

    let matches: SecretMatch[];
    const content = stringField(call.input, 'content');
    const append = stringField(call.input, 'append');
    const find = stringField(call.input, 'find');
    const replace = stringField(call.input, 'replace');
    if (content !== undefined) {
      matches = newSecrets(before, content);
    } else if (append !== undefined) {
      matches = scanSecrets(append);
    } else if (replace !== undefined) {
      const edited = before !== null && find !== undefined ? applySingleEdit(before, find, replace) : null;
      matches = edited !== null ? newSecrets(before, edited) : scanSecrets(replace);
    } else {
      return { decision: 'pass' };
    }
    if (matches.length === 0) return { decision: 'pass' };
    return {
      decision: 'block',
      reason: [
        `secret-guard: the content looks like it contains a secret:`,
        ...formatSecretMatches(where, matches).map((l) => `  ${l}`),
        'Never hard-code credentials: read them from configuration (process.env) and use obvious placeholders in tests.',
      ].join('\n'),
    };
  },
});
