import type { User } from '../schemas/users.ts';

export function looseIds(values: unknown[]): string[] {
  const list: Array<any> = values;
  return list.map((v) => String(v));
}

export function meta(raw: unknown): Record<string, any> {
  return <any>raw;
}

export function trusted(raw: unknown): User {
  return raw as unknown as User;
}
