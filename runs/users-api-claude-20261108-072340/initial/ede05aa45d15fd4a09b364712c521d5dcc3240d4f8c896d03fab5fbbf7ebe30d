import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CursorQuerySchema, decodeCursor, encodeCursor, pageSchema, paginate } from '../../src/lib/pagination.ts';
import { HttpProblem } from '../../src/lib/problem.ts';

const items = Array.from({ length: 45 }, (_, i) => ({ id: `item-${String(i).padStart(3, '0')}` }));
const key = (item: { id: string }): string => item.id;

describe('CursorQuerySchema', () => {
  it('defaults limit to 20 and coerces query strings', () => {
    expect(CursorQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(CursorQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({ limit: 5, cursor: 'abc' });
  });

  it('rejects limits outside 1..100 and empty cursors', () => {
    expect(CursorQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(CursorQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(CursorQuerySchema.safeParse({ limit: '2.5' }).success).toBe(false);
    expect(CursorQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('cursors', () => {
  it('round-trips a key through an opaque base64url cursor', () => {
    const cursor = encodeCursor('2024-01-01T00:00:00.000Z|abc');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toBe('2024-01-01T00:00:00.000Z|abc');
  });

  it('rejects cursors it did not issue with a 422 problem', () => {
    for (const bad of ['not-a-cursor', Buffer.from('{"x":1}').toString('base64url')]) {
      try {
        decodeCursor(bad);
        expect.unreachable('decodeCursor should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpProblem);
        expect(err instanceof HttpProblem ? err.status : 0).toBe(422);
      }
    }
  });
});

describe('paginate', () => {
  it('walks every item exactly once, in key order', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = paginate(items, CursorQuerySchema.parse({ limit: '20', cursor }), key);
      seen.push(...page.data.map(key));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual(items.map(key));
  });

  it('returns nextCursor null on the last page', () => {
    const page = paginate(items.slice(0, 3), CursorQuerySchema.parse({}), key);
    expect(page.data).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('does not depend on input order and survives deletion of the cursor item', () => {
    const shuffled = [...items].reverse();
    const first = paginate(shuffled, CursorQuerySchema.parse({ limit: 2 }), key);
    expect(first.data.map(key)).toEqual(['item-000', 'item-001']);
    const withoutLast = shuffled.filter((item) => item.id !== 'item-001');
    const second = paginate(withoutLast, CursorQuerySchema.parse({ limit: 2, cursor: first.nextCursor }), key);
    expect(second.data.map(key)).toEqual(['item-002', 'item-003']);
  });

  it('builds a page schema with data and nextCursor', () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    expect(schema.parse({ data: [{ id: 'a' }], nextCursor: null })).toEqual({ data: [{ id: 'a' }], nextCursor: null });
    expect(schema.safeParse({ data: [{ id: 1 }], nextCursor: null }).success).toBe(false);
  });
});
