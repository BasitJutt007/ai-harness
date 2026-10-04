/**
 * secret-guard (pre, write): refuses content that looks like a credential
 * (prefixed API keys, cloud keys, tokens, PEM private keys, hard-coded api keys).
 * Writes are judged by the file they would produce (the loop's post-image), so a key
 * split across several small edits is caught on the edit that completes it, whatever
 * write tool carries it. A write tool without preview() is refused (fail closed).
 */
import { defineHook } from '../../src/core/plugin-api.ts';
import { toApiRel } from '../lib/path-policy.ts';
import { postImage } from '../lib/post-image.ts';
import { formatSecretMatches, newSecrets } from '../lib/secrets.ts';

export default defineHook({
  name: 'secret-guard',
  description: 'Blocks writes whose content contains key-like secrets.',
  events: ['pre_tool'],
  effects: ['write'],
  async run(event, ctx) {
    if (event.event !== 'pre_tool') return { decision: 'pass' };
    const { call } = event;
    for (const p of call.paths) {
      const img = postImage(call, p);
      if (!img.ok) return { decision: 'block', reason: `secret-guard: ${img.reason}` };
      if (img.after === null) continue; // no file afterwards
      const r = toApiRel(ctx.workspace, p);
      const before = r.ok ? await ctx.workspace.read(r.rel) : null;
      const matches = newSecrets(before, img.after);
      if (matches.length === 0) continue;
      return {
        decision: 'block',
        reason: [
          `secret-guard: the content looks like it contains a secret:`,
          ...formatSecretMatches(r.ok ? r.rel : p, matches).map((l) => `  ${l}`),
          'Never hard-code credentials: read them from configuration (process.env) and use obvious placeholders in tests.',
        ].join('\n'),
      };
    }
    return { decision: 'pass' };
  },
});
