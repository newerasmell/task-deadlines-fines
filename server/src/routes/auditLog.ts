import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const auditLogRouter = Router();

auditLogRouter.use(requireAuth, requireAdmin);

// Inserts `за задача "<title>"` right before the first ": " in a fine's
// summary line, e.g. "Наложена глоба на Anna: 50 EUR" -> "Наложена глоба на
// Anna за задача "...": 50 EUR". A no-op if the task is already named (the
// route that creates the log entry has included it since it was fixed) or
// the summary doesn't have the expected shape.
function injectTaskTitle(summary: string, taskTitle: string): string {
  if (summary.includes(' за задача "')) return summary;
  const idx = summary.indexOf(": ");
  if (idx === -1) return summary;
  return `${summary.slice(0, idx)} за задача "${taskTitle}"${summary.slice(idx)}`;
}

// Fine-related audit log rows created before the task title was added to
// their summary text are stuck with whatever string was written at the
// time — an AuditLog row is a historical record, so fixing the summary
// generator doesn't touch rows already saved. Patched in here at read time
// instead of a one-off migration, so every fine entry shows its task
// regardless of when it was logged.
async function withTaskTitles<T extends { action: string; entityType: string; entityId: string; summary: string }>(
  logs: T[]
): Promise<T[]> {
  const fineIds = logs
    .filter((l) => l.entityType === "Fine" && (l.action === "FINE_CREATED" || l.action === "FINE_WAIVED"))
    .map((l) => l.entityId);
  if (fineIds.length === 0) return logs;

  const fines = await prisma.fine.findMany({
    where: { id: { in: fineIds } },
    select: { id: true, task: { select: { title: true } } },
  });
  const taskTitleByFineId = new Map(fines.filter((f) => f.task).map((f) => [f.id, f.task!.title]));

  return logs.map((l) => {
    const taskTitle = taskTitleByFineId.get(l.entityId);
    return taskTitle ? { ...l, summary: injectTaskTitle(l.summary, taskTitle) } : l;
  });
}

auditLogRouter.get("/", async (req, res) => {
  const take = Math.min(Number(req.query.limit) || 100, 200);
  const logs = await prisma.auditLog.findMany({
    include: { actor: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });
  res.json(await withTaskTitles(logs));
});
