import { prisma } from "./prisma";

export type AdminAction =
  | "TASK_CREATED"
  | "TASK_UPDATED"
  | "TASK_DELETED"
  | "TASK_REOPENED"
  | "FINE_CREATED"
  | "FINE_WAIVED"
  | "FINE_AMOUNT_EDITED"
  | "FINE_PAID_BULK"
  | "FINE_CONSOLIDATED"
  | "VAULT_INITIALIZED"
  | "VAULT_ACCESS_GRANTED"
  | "VAULT_ACCESS_REVOKED"
  | "VAULT_ENTRY_CREATED"
  | "VAULT_ENTRY_UPDATED"
  | "VAULT_ENTRY_DELETED";

export function logAction(
  actorId: string,
  action: AdminAction,
  entityType: string,
  entityId: string,
  summary: string,
  details?: unknown
): Promise<unknown> {
  return prisma.auditLog.create({
    data: {
      actorId,
      action,
      entityType,
      entityId,
      summary,
      details: details !== undefined ? JSON.stringify(details) : undefined,
    },
  });
}
