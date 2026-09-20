import { Router } from "express";
import { prisma } from "../lib/prisma";

export const auditLogRouter = Router();

auditLogRouter.get("/", async (req, res) => {
  const { actorId, action, search } = req.query as Record<string, string | undefined>;

  const logs = await prisma.auditLog.findMany({
    where: {
      ...(actorId ? { actorId } : {}),
      ...(action ? { action } : {}),
      ...(search ? { summary: { contains: search } } : {}),
    },
    include: { actor: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  res.json(
    logs.map((l) => ({
      id: l.id,
      actor: l.actor ? { id: l.actor.id, name: l.actor.name, email: l.actor.email } : null,
      action: l.action,
      entityType: l.entityType,
      entityId: l.entityId,
      summary: l.summary,
      createdAt: l.createdAt,
    }))
  );
});
