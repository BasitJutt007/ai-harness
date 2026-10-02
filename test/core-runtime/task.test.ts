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

  it('rejects a "model:" key with a message naming it', async () => {
    await expect(loadTask(file('m.task.yaml', `${GREEN}model: some-model\n`))).rejects.toThrow(/unknown key "model"/);
    await expect(loadTask(file('m2.task.yaml', BROWN.replace('title:', 'provider: x\ntitle:')))).rejects.toThrow(/"provider"/);
  });

  it('rejects unknown keys in nested objects', async () => {
    const bad = GREEN.replace('{ name: email, type: email,', '{ name: email, type: email, colour: red,');
    await expect(loadTask(file('n.task.yaml', bad))).rejects.toThrow(/resources\.0\.fields\.0: unknown key "colour"/);
  });

  it('rejects a bad id', async () => {
    await expect(loadTask(file('b.task.yaml', GREEN.replace('id: users-api', 'id: Users_API')))).rejects.toThrow(/id must match/);
    await expect(loadTask(file('b2.task.yaml', GREEN.replace('id: users-api', 'id: -users')))).rejects.toThrow(/id/);
  });

  it('rejects server-managed fields, enum without values, and escaping paths', async () => {
    await expect(loadTask(file('s.task.yaml', GREEN.replace('name: email,', 'name: id,')))).rejects.toThrow(/server-managed/);
    await expect(loadTask(file('e.task.yaml', GREEN.replace(', values: [admin, member]', '')))).rejects.toThrow(/values/);
    await expect(loadTask(file('o.task.yaml', GREEN.replace('generated/users-api', '../outside')))).rejects.toThrow(/\.\./);
  });

  it('limits.maxOutputTokens accepts up to 128000 and rejects more', async () => {
    const at = (n: number): string => `${GREEN}limits: { maxTurns: 10, maxOutputTokens: ${n} }\n`;
    const ok = await loadTask(file('l1.task.yaml', at(128000)));
    expect(ok.task.limits).toEqual({ maxTurns: 10, maxOutputTokens: 128000 });
    await expect(loadTask(file('l2.task.yaml', at(128001)))).rejects.toThrow(/limits\.maxOutputTokens/);
    await expect(loadTask(file('l3.task.yaml', at(255)))).rejects.toThrow(/limits\.maxOutputTokens/);
  });

  it('rejects unsupported extensions', async () => {
    await expect(loadTask(file('t.task.txt', GREEN))).rejects.toThrow(/unsupported/);
  });
});
