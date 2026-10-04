import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler, notFoundHandler } from '../../src/lib/errors.ts';
import { idempotency } from '../../src/lib/idempotency.ts';
import { notFound, ProblemSchema } from '../../src/lib/problem.ts';

const NoteSchema = z.object({ id: z.uuid(), text: z.string().min(1) });
const CreateNoteSchema = NoteSchema.pick({ text: true });

/** A test app whose POST handler counts invocations and can be held open. */
function noteApp() {
  let created = 0;
  let gate: Promise<void> = Promise.resolve();
  const app = express();
  app.use(express.json());
  const notes = new Map<string, z.infer<typeof NoteSchema>>();
  app.post('/v1/notes', idempotency(), async (req, res) => {
    const body = CreateNoteSchema.parse(req.body);
    await gate;
    created += 1;
    const note = NoteSchema.parse({ id: randomUUID(), ...body });
    notes.set(note.id, note);
    // Sends the stored object itself: a later in-place update must not reach a replay of this response.
    res.status(201).location(`/v1/notes/${note.id}`).json(note);
  });
  app.patch('/v1/notes/:id', idempotency(), (req, res) => {
    const note = notes.get(String(req.params['id']));
    if (note === undefined) throw notFound('note not found');
    Object.assign(note, CreateNoteSchema.partial().parse(req.body));
    res.json(note);
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return {
    app,
    created: () => created,
    hold(): () => void {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
  };
}

describe('idempotency()', () => {
  it('runs every request when no Idempotency-Key is sent', async () => {
    const t = noteApp();
    await request(t.app).post('/v1/notes').send({ text: 'a' }).expect(201);
    await request(t.app).post('/v1/notes').send({ text: 'a' }).expect(201);
    expect(t.created()).toBe(2);
  });

  it('replays the stored response for the same key and body', async () => {
    const t = noteApp();
    const first = await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-1').send({ text: 'a' });
    const second = await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-1').send({ text: 'a' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['location']).toBe(first.headers['location']);
    expect(NoteSchema.parse(second.body)).toEqual(NoteSchema.parse(first.body));
    expect(t.created()).toBe(1);
  });

  it('replays the original response byte for byte after the resource was updated in place', async () => {
    const t = noteApp();
    const first = await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-5').send({ text: 'original' });
    expect(first.status).toBe(201);
    const id = NoteSchema.parse(first.body).id;
    const patched = await request(t.app).patch(`/v1/notes/${id}`).send({ text: 'changed' });
    expect(NoteSchema.parse(patched.body).text).toBe('changed');
    const replay = await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-5').send({ text: 'original' });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.headers['content-type']).toBe(first.headers['content-type']);
    expect(replay.text).toBe(first.text);
    expect(NoteSchema.parse(replay.body).text).toBe('original');
    expect(t.created()).toBe(1);
  });

  it('rejects reuse of a key with a different body as a 422 problem', async () => {
    const t = noteApp();
    await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-2').send({ text: 'a' }).expect(201);
    const res = await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-2').send({ text: 'b' });
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(ProblemSchema.parse(res.body).type).toBe('https://api.sf/problems/idempotency-key-reuse');
    expect(t.created()).toBe(1);
  });

  it('answers a duplicate that arrives while the first is in flight with a 409 problem', async () => {
    const t = noteApp();
    const release = t.hold();
    const first = request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-3').send({ text: 'a' }).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-3').send({ text: 'a' });
    release();
    expect(second.status).toBe(409);
    expect(ProblemSchema.parse(second.body).type).toBe('https://api.sf/problems/idempotency-key-in-flight');
    expect((await first).status).toBe(201);
    expect(t.created()).toBe(1);
  });

  it('does not remember failed requests, so a corrected retry may reuse the key', async () => {
    const t = noteApp();
    await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-4').send({ text: '' }).expect(422);
    await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-4').send({ text: '' }).expect(422);
    const ok = await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k-4').send({ text: 'fixed' });
    expect(ok.status).toBe(201);
  });

  it('validates the header: keys longer than 255 characters are a 422 problem', async () => {
    const t = noteApp();
    const res = await request(t.app).post('/v1/notes').set('Idempotency-Key', 'k'.repeat(256)).send({ text: 'a' });
    expect(res.status).toBe(422);
    expect(ProblemSchema.parse(res.body).detail).toContain('idempotency-key');
    expect(t.created()).toBe(0);
  });
});
