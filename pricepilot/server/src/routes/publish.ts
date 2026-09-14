import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { publishPrices } from "../services/publishEngine";

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
  res.json({ results });
});
