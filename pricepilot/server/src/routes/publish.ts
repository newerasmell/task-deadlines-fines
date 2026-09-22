import { Router } from "express";
import { z } from "zod";
import { logAudit } from "../lib/audit";
import { prisma } from "../lib/prisma";
import { publishPrices, revertPublishes } from "../services/publishEngine";

export const publishRouter = Router();

const publishSchema = z.object({
  storeId: z.string().min(1),
  mode: z.enum(["single", "bulk"]),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        newPrice: z.number().positive(),
        setCompareAt: z.boolean().default(false),
        newCompareAtPrice: z.number().positive().nullable().optional(),
      })
    )
    .min(1),
});

publishRouter.post("/", async (req, res) => {
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const store = await prisma.store.findUnique({ where: { id: parsed.data.storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  const results = await publishPrices(store, parsed.data.items, parsed.data.mode);
  const successCount = results.filter((r) => r.status === "SUCCESS").length;
  const failCount = results.length - successCount;
  await logAudit(
    req.userId!,
    "PRICE_PUBLISHED",
    "Store",
    store.id,
    `Published ${successCount} price(s) to ${store.name} (${parsed.data.mode})${failCount > 0 ? `, ${failCount} failed` : ""}`
  );
  res.json({ results });
});

const revertSchema = z.object({
  storeId: z.string().min(1),
  logIds: z.array(z.string().min(1)).min(1),
});

publishRouter.post("/revert", async (req, res) => {
  const parsed = revertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const store = await prisma.store.findUnique({ where: { id: parsed.data.storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  const results = await revertPublishes(store, parsed.data.logIds);
  const successCount = results.filter((r) => r.status === "SUCCESS").length;
  const failCount = results.length - successCount;
  await logAudit(
    req.userId!,
    "PRICE_PUBLISHED",
    "Store",
    store.id,
    `Reverted ${successCount} publish log entr${successCount === 1 ? "y" : "ies"} on ${store.name}${failCount > 0 ? `, ${failCount} failed` : ""}`
  );
  res.json({ results });
});
