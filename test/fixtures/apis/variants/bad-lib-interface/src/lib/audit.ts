export interface AuditEntry {
  at: string;
  action: 'create' | 'update' | 'delete';
  userId: string;
}

export const auditLog: AuditEntry[] = [];
