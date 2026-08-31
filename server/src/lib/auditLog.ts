import { prisma } from "./prisma";

export type AdminAction = "TASK_CREATED" | "TASK_UPDATED" | "TASK_DELETED" | "FINE_CREATED" | "FINE_WAIVED";

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
