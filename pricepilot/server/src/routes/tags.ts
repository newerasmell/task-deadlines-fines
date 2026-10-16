import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { logAudit } from "../lib/audit";
import { prisma } from "../lib/prisma";
import { setProductTag } from "../services/publishEngine";

export const tagsRouter = Router();

const setTagSchema = z.object({
  storeId: z.string().min(1),
  productIds: z.array(z.string().min(1)).min(1),
  tag: z.string().min(1).max(50),
});

async function handleSetTag(req: Request, res: Response, mode: "add" | "remove") {
  const parsed = setTagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const store = await prisma.store.findUnique({ where: { id: parsed.data.storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  const results = await setProductTag(store, parsed.data.productIds, parsed.data.tag, mode);
  const successCount = results.filter((r) => r.status === "SUCCESS").length;
  const failCount = results.length - successCount;
  await logAudit(
    req.userId ?? null,
    "PRODUCT_TAG_UPDATED",
    "Product",
    null,
    `${mode === "add" ? "Added" : "Removed"} tag "${parsed.data.tag}" ${mode === "add" ? "to" : "from"} ${successCount} product(s) on ${store.name}${failCount > 0 ? `, ${failCount} failed` : ""}`
  );

  res.json({ results });
}

tagsRouter.post("/add", (req, res) => handleSetTag(req, res, "add"));
tagsRouter.post("/remove", (req, res) => handleSetTag(req, res, "remove"));
