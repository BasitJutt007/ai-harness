export function paginate<T extends { id: string }>(rows: T[], cursor: string | undefined, limit: number): { data: T[]; nextCursor: string | null } {
  const start = cursor === undefined ? 0 : rows.findIndex((r) => r.id === cursor) + 1;
  const data = rows.slice(start, start + limit);
  const last = data.at(-1);
  return { data, nextCursor: last !== undefined && start + limit < rows.length ? last.id : null };
}
