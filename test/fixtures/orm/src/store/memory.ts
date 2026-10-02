// An in-memory users store: Map calls are not ORM queries (no finding for this file).
export class UserStore {
  private readonly users = new Map<string, { id: string; email: string }>();

  remove(id: string): boolean {
    return this.users.delete(id);
  }

  all(): Array<{ id: string; email: string }> {
    return Array.from(this.users.values());
  }
}
