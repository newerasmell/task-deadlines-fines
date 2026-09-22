import { prisma } from "./prisma";

export type AuditAction =
  | "GROUP_CREATED"
  | "GROUP_UPDATED"
  | "GROUP_DELETED"
  | "STORE_CREATED"
  | "STORE_UPDATED"
  | "STORE_DELETED"
  | "SOURCE_CREATED"
  | "SOURCE_UPDATED"
  | "SOURCE_DELETED"
  | "COST_IMPORTED"
  | "COST_UPDATED"
  | "COD_CONFIG_UPDATED"
  | "CATEGORY_COST_UPDATED"
  | "CATEGORY_COST_CLEARED"
  | "CATEGORY_BASE_PRICE_UPDATED"
  | "BRAND_COEFFICIENT_UPDATED"
  | "PRICE_PUBLISHED"
  | "USER_CREATED"
  | "USER_UPDATED"
  | "USER_DELETED";

/**
 * Records one line in the audit trail. actorId is nullable — every route
 * that calls this sits behind requireAuth so it's normally always set, but
 * the FK itself allows null (a deactivated/deleted user's past rows stay
 * readable, see AuditLog's onDelete: SetNull) so this mirrors that instead
 * of forcing a throwaway "system" user into existence.
 */
export function logAudit(
  actorId: string | null,
  action: AuditAction,
  entityType: string,
  entityId: string | null,
  summary: string
): Promise<unknown> {
  return prisma.auditLog.create({ data: { actorId, action, entityType, entityId, summary } });
}
