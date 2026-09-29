import { Router } from "express";
import { getRatesTo } from "../lib/exchangeRates";
import { prisma } from "../lib/prisma";

export const publishLogRouter = Router();

publishLogRouter.get("/", async (req, res) => {
  const { storeId, status, source, search } = req.query as Record<string, string | undefined>;
  if (!storeId) return res.status(400).json({ error: "storeId is required" });

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });

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

  const storeCurrencyEurRate =
    store.currency !== "EUR" ? (await getRatesTo([store.currency], "EUR")).get(store.currency) ?? null : null;

  res.json({ entries: logs, currency: store.currency, storeCurrencyEurRate });
});
