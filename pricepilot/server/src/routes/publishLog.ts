import { Router } from "express";
import { prisma } from "../lib/prisma";

export const publishLogRouter = Router();

publishLogRouter.get("/", async (req, res) => {
  const { storeId, status, source, search } = req.query as Record<string, string | undefined>;
  if (!storeId) return res.status(400).json({ error: "storeId is required" });

  const logs = await prisma.publishLog.findMany({
    where: {
      storeId,
      ...(status ? { status } : {}),
      ...(source ? { source } : {}),
      ...(search ? { productTitle: { contains: search } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  res.json(logs);
});
