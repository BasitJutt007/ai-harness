import { expect, it } from 'vitest';
import { firstOf } from '../src/util/format.js';

it('returns the first item', () => {
  const items = ['a'] as any;
  expect(firstOf(items)).toBe('a');
});
