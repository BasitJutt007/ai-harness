import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadTask } from '../../src/core/task.ts';
import { repoTmp } from './helpers.ts';

const tmp = repoTmp('task');
afterAll(() => tmp.cleanup());

function file(name: string, body: string): string {
  const p = join(tmp.dir, name);
  writeFileSync(p, body);
  return p;
}

const GREEN = `kind: greenfield
id: users-api
title: Users API
output: generated/users-api
resources:
  - name: user
    fields:
      - { name: email, type: email, required: true, unique: true }
      - { name: name, type: string, required: true, min: 1, max: 100 }
      - { name: role, type: enum, values: [admin, member], default: member }
behaviours:
  - "Creating a user whose email already exists returns 409."
`;

const BROWN = `kind: brownfield
id: projects-change
title: Add archived flag
target: samples/existing-api
change: |
  Add an optional archived boolean.
behaviours: [ "PATCH can archive a project" ]
`;

describe('task loading', () => {
  it('loads a greenfield task with defaults and derived plural', async () => {
    const p = file('users.task.yaml', GREEN);
    const lt = await loadTask(p);
    expect(lt.file).toBe(p);
    expect(lt.sha256).toBe(createHash('sha256').update(readFileSync(p)).digest('hex'));
    const t = lt.task;
    if (t.kind !== 'greenfield') throw new Error('expected greenfield');
    expect(t.template).toBe('express-zod');
    expect(t.basePath).toBe('/v1');
    expect(t.limits).toEqual({ maxTurns: 60, maxOutputTokens: 16000 });
    const r = t.resources[0];
    expect(r?.plural).toBe('users');
    expect(r?.operations).toEqual(['list', 'get', 'create', 'update', 'delete']);
    expect(r?.fields[0]).toMatchObject({ name: 'email', required: true, unique: true, readOnly: false });
    expect(r?.fields[1]).toMatchObject({ required: true, unique: false, min: 1, max: 100 });
    expect(r?.fields[2]).toMatchObject({ type: 'enum', values: ['admin', 'member'], default: 'member', required: false });
  });

  it('loads a brownfield task with scope defaults', async () => {
    const lt = await loadTask(file('p.task.yml', BROWN));
    const t = lt.task;
    if (t.kind !== 'brownfield') throw new Error('expected brownfield');
    expect(t.scope).toEqual({ allow: ['src/**/*.ts', 'test/**/*.ts'], deny: [] });
    expect(t.allowBreaking).toBe(false);
    expect(t.change).toContain('archived');
    expect(t.behaviours).toEqual(['PATCH can archive a project']);
  });

  it('loads JSON task files', async () => {
    const json = { kind: 'brownfield', id: 'x1', title: 'X', target: 'a/b', change: 'c', allowBreaking: true };
    const lt = await loadTask(file('x.task.json', JSON.stringify(json)));
    expect(lt.task.kind).toBe('brownfield');
    expect(lt.task.behaviours).toEqual([]);
  });

  it('rejects a "model:" key with a message naming it (lenient and strict)', async () => {
    for (const strict of [false, true]) {
      await expect(loadTask(file('m.task.yaml', `${GREEN}model: some-model\n`), { strict })).rejects.toThrow(/key "model" is not allowed: task files are provider-neutral/);
      await expect(loadTask(file('m2.task.yaml', BROWN.replace('title:', 'provider: x\ntitle:')), { strict })).rejects.toThrow(/"provider"/);
    }
  });

  // Old behaviour: every unknown nested key was an error. Field-level extras only reach the prompt, so the
  // lenient front end keeps them in the field description (with a note); --strict-task keeps the old error.
  it('unknown keys in nested objects: kept in the description (lenient), rejected (--strict-task)', async () => {
    const bad = GREEN.replace('{ name: email, type: email,', '{ name: email, type: email, colour: red,');
    const lt = await loadTask(file('n.task.yaml', bad));
    if (lt.task.kind !== 'greenfield') throw new Error('expected greenfield');
    expect(lt.task.resources[0]?.fields[0]?.description).toBe('colour: red');
    expect(lt.warnings.join('\n')).toMatch(/"colour" kept in the field description/);
    await expect(loadTask(file('n.task.yaml', bad), { strict: true })).rejects.toThrow(/resources\.0\(user\)\.fields\.0\(email\): unknown key "colour"/);
  });

  // Old behaviour: a non-slug id was an error. The id only names the run, branch and package, so it is slugified (noted).
  it('a bad id: slugified with a note (lenient), rejected (--strict-task)', async () => {
    const lt = await loadTask(file('b.task.yaml', GREEN.replace('id: users-api', 'id: Users_API')));
    expect(lt.task.id).toBe('users-api');
    expect(lt.warnings).toContain('id "Users_API" -> "users-api"');
    expect((await loadTask(file('b2.task.yaml', GREEN.replace('id: users-api', 'id: -users')))).task.id).toBe('users');
    await expect(loadTask(file('b.task.yaml', GREEN.replace('id: users-api', 'id: Users_API')), { strict: true })).rejects.toThrow(/id must match/);
    await expect(loadTask(file('b3.task.yaml', GREEN.replace('id: users-api', 'id: "!!!"')))).rejects.toThrow(/id: "!!!" has no letters or digits/);
  });

  // Old behaviour: listing id/createdAt/updatedAt was an error; the brief already says they are implied, so they are dropped (noted).
  it('server-managed fields: dropped with a note (lenient), rejected (--strict-task); enum without values and escaping paths always rejected', async () => {
    const sm = await loadTask(file('s.task.yaml', GREEN.replace('name: email,', 'name: id,')));
    if (sm.task.kind !== 'greenfield') throw new Error('expected greenfield');
    expect(sm.task.resources[0]?.fields.map((f) => f.name)).toEqual(['name', 'role']);
    expect(sm.warnings.join('\n')).toMatch(/server-managed/);
    await expect(loadTask(file('s.task.yaml', GREEN.replace('name: email,', 'name: id,')), { strict: true })).rejects.toThrow(/server-managed/);
    for (const strict of [false, true]) {
      await expect(loadTask(file('e.task.yaml', GREEN.replace(', values: [admin, member]', '')), { strict })).rejects.toThrow(/enum fields need "values"/);
      await expect(loadTask(file('o.task.yaml', GREEN.replace('generated/users-api', '../outside')), { strict })).rejects.toThrow(/\.\./);
    }
  });

  it('limits.maxOutputTokens accepts up to 128000 and rejects more', async () => {
    const at = (n: number): string => `${GREEN}limits: { maxTurns: 10, maxOutputTokens: ${n} }\n`;
    const ok = await loadTask(file('l1.task.yaml', at(128000)));
    expect(ok.task.limits).toEqual({ maxTurns: 10, maxOutputTokens: 128000 });
    await expect(loadTask(file('l2.task.yaml', at(128001)))).rejects.toThrow(/limits\.maxOutputTokens/);
    await expect(loadTask(file('l3.task.yaml', at(255)))).rejects.toThrow(/limits\.maxOutputTokens/);
  });

  // Old behaviour: .txt was unsupported. .md/.txt are now free text (the whole file is the brief), so the
  // unsupported-extension error is shown with formats that are still unsupported.
  it('rejects unsupported extensions; --strict-task accepts only .yaml/.yml/.json', async () => {
    await expect(loadTask(file('t.task.toml', GREEN))).rejects.toThrow(/unsupported task file extension ".toml"/);
    await expect(loadTask(file('t.task.xml', GREEN))).rejects.toThrow(/unsupported/);
    await expect(loadTask(file('t.task.txt', 'Build a pets API.'), { strict: true })).rejects.toThrow(/--strict-task accepts \.yaml, \.yml or \.json/);
    expect((await loadTask(file('t.task.txt', 'Build a pets API.'))).task).toMatchObject({ kind: 'greenfield', brief: 'Build a pets API.' });
  });

  it('records a stable normalizedSha256 (key order independent) next to the raw sha', async () => {
    const a = await loadTask(file('h1.task.json', JSON.stringify({ kind: 'brownfield', id: 'x', title: 'X', target: 'a', change: 'c' })));
    const b = await loadTask(file('h2.task.json', JSON.stringify({ change: 'c', target: 'a', title: 'X', id: 'x', kind: 'brownfield' })));
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.normalizedSha256).toBe(b.normalizedSha256);
    expect(a.normalizedSha256).toMatch(/^[0-9a-f]{64}$/);
    const c = await loadTask(file('h3.task.json', JSON.stringify({ kind: 'brownfield', id: 'x', title: 'X', target: 'a', change: 'd' })));
    expect(c.normalizedSha256).not.toBe(a.normalizedSha256);
  });
});
