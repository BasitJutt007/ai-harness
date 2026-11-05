import { expect, test } from 'vitest';
import { greeting } from '../src/greeting.ts';

test('greets by name', () => {
  expect(greeting('Ada')).toBe('Hello, Ada');
});
