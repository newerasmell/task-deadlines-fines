import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const auditLogRouter = Router();

auditLogRouter.use(requireAuth, requireAdmin);

auditLogRouter.get("/", async (req, res) => {
  const take = Math.min(Number(req.query.limit) || 100, 200);
  const logs = await prisma.auditLog.findMany({
    include: { actor: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });
  res.json(logs);
});
