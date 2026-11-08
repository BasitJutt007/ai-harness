/**
 * edit_file and one uniform indentation slip: models copy indentation from numbered read_file output and
 * are often a space off. With no exact occurrence, a block that matches line for line except for ONE uniform
 * shift (spaces only) is the edit, when it is the only such block, and the replacement is re-indented by the
 * same shift. Exact matches are unchanged; ambiguous, mixed or tabbed matches are still refused; the preview
 * the hooks judge is the same post-image the tool writes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import editFile from '../../plugins/tools/edit_file.ts';
import { matchEdit, proposedContent } from '../../plugins/lib/diff.ts';
import { makeHarness, removeTmp } from './helpers.ts';

const SCREEN = [
  'export function Screen() {',
  '  return (',
  '              <Typography',
  '                marginBottom={4}',
  '              >',
  '                {email}',
  '              </Typography>',
  '  );',
  '}',
  '',
].join('\n');

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTmp));
});

describe('matchEdit', () => {
  it('an exact unique occurrence applies as before', () => {
    const m = matchEdit(SCREEN, '{email}', '{sentEmail}');
    expect(m.kind).toBe('exact');
    expect(m.kind !== 'none' && m.result).toBe(SCREEN.replace('{email}', '{sentEmail}'));
  });

  it('a block one space too deep matches and the replacement is shifted back by the same space', () => {
    const find = '               <Typography\n                 marginBottom={4}\n               >\n                 {email}\n               </Typography>';
    const replace = '               <Typography\n                 marginBottom={4}\n               >\n                 {sentEmail}\n               </Typography>';
    const m = matchEdit(SCREEN, find, replace);
    expect(m).toMatchObject({ kind: 'indent', line: 3, delta: -1 });
    expect(m.kind !== 'none' && m.result).toBe(SCREEN.replace('{email}', '{sentEmail}'));
  });

  it('a block indented too little matches and the replacement gains the same indent', () => {
    const m = matchEdit(SCREEN, '<Typography\n  marginBottom={4}\n>', '<Typography\n  marginBottom={2}\n>');
    expect(m).toMatchObject({ kind: 'indent', delta: 14 });
    expect(m.kind !== 'none' && m.result).toBe(SCREEN.replace('marginBottom={4}', 'marginBottom={2}'));
  });

  it('refuses a block that matches more than once ignoring indentation, mixed shifts, and tabs', () => {
    const twice = `${SCREEN}${SCREEN}`;
    expect(matchEdit(twice, '                 {email}', '                 {x}')).toEqual({ kind: 'none', exact: 0, indent: 2 });
    // The first line one space off, the second two: not one uniform shift.
    expect(matchEdit(SCREEN, '               <Typography\n                  marginBottom={4}', 'x').kind).toBe('none');
    expect(matchEdit(SCREEN.replace('                {email}', '\t{email}'), ' {email}', '{x}').kind).toBe('none');
  });

  it('text that differs beyond indentation is no match', () => {
    expect(matchEdit(SCREEN, '                {emails}', 'x').kind).toBe('none');
  });
});

describe('edit_file with an indentation slip', () => {
  it('edits, says so, and writes exactly the post-image the preview showed', async () => {
    const h = await makeHarness({ label: 'edit-indent', files: { 'src/screen.tsx': SCREEN } });
    dirs.push(h.dir);
    const input = { path: 'src/screen.tsx', find: '                 {email}', replace: '                 {sentEmail}' };
    const preview = proposedContent(input, SCREEN);
    const r = await editFile.run(editFile.input.parse(input), h.ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/find matched at line 6 with the file's lines indented 1 space\(s\) less than given, and replace was re-indented/);
    const written = await h.ctx.workspace.read('src/screen.tsx');
    expect(written).toBe(SCREEN.replace('{email}', '{sentEmail}'));
    expect(written).toBe(preview);
  });

  it('still refuses text that is not there, and an ambiguous indentation match, leaving the file as it was', async () => {
    const h = await makeHarness({ label: 'edit-indent', files: { 'src/screen.tsx': `${SCREEN}${SCREEN}` } });
    dirs.push(h.dir);
    const missing = await editFile.run(editFile.input.parse({ path: 'src/screen.tsx', find: 'nothing like this', replace: 'x' }), h.ctx);
    expect(missing.ok).toBe(false);
    const twice = await editFile.run(editFile.input.parse({ path: 'src/screen.tsx', find: '                 {email}', replace: '                 {x}' }), h.ctx);
    expect(twice).toMatchObject({ ok: false, summary: expect.stringMatching(/matches 2 places ignoring indentation/) });
    expect(await h.ctx.workspace.read('src/screen.tsx')).toBe(`${SCREEN}${SCREEN}`);
  });
});
