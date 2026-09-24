import type { Store } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { logAudit } from "../lib/audit";
import { encrypt } from "../lib/crypto";
import { prisma } from "../lib/prisma";
import { syncCatalog } from "../services/catalogSync";
import { syncOrders } from "../services/ordersSync";
import { syncPageViews } from "../services/pageViewsSync";
import { testShopifyConnection } from "../services/shopifyClient";

export const storesRouter = Router();

// shopifyClientSecret is encrypted at rest and NEVER sent back to the client
// — only whether one is on file, so the Settings UI can show "configured".
function toStoreDto(store: Store) {
  const { shopifyClientSecret, ...rest } = store;
  return { ...rest, hasClientSecret: Boolean(shopifyClientSecret) };
}

storesRouter.get("/", async (_req, res) => {
  const stores = await prisma.store.findMany({ orderBy: { name: "asc" } });
  res.json(stores.map(toStoreDto));
});

const createSchema = z.object({
  name: z.string().min(1),
  myshopifyDomain: z.string().min(1),
  shopifyClientId: z.string().min(1),
  shopifyClientSecret: z.string().min(1),
  marketCode: z.string().min(1),
  currency: z.string().min(1),
  pricingStrategy: z.enum(["undercut_min", "match_min", "undercut_avg"]).default("undercut_min"),
  undercutPct: z.number().nonnegative().default(1),
  priceEnding: z.string().nullable().optional(),
  minMarginPct: z.number().nonnegative().default(10),
  pricingProfile: z.enum(["competitor", "cod_formula"]).default("competitor"),
  groupId: z.string().nullable().optional(),
  salesAnalyticsEnabled: z.boolean().default(false),
  ga4PropertyId: z.string().nullable().optional(),
  markdownEnabled: z.boolean().default(false),
  markdownCollectionId: z.string().nullable().optional(),
  markdownAfterDays: z.number().int().positive().default(8),
  markdownCeilingPct: z.number().nonnegative().default(12.5),
  newArrivalTag: z.string().default("c_newcollection"),
});

storesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { shopifyClientSecret, ...rest } = parsed.data;
  const store = await prisma.store.create({
    data: { ...rest, shopifyClientSecret: encrypt(shopifyClientSecret) },
  });
  await logAudit(req.userId!, "STORE_CREATED", "Store", store.id, `Added store ${store.name}`);
  res.status(201).json(toStoreDto(store));
});

const updateSchema = createSchema.partial().extend({
  shopifyClientSecret: z.string().min(1).optional(), // omit to leave the existing secret untouched
});

storesRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { shopifyClientSecret, ...rest } = parsed.data;
  try {
    const store = await prisma.store.update({
      where: { id: req.params.id },
      data: { ...rest, ...(shopifyClientSecret ? { shopifyClientSecret: encrypt(shopifyClientSecret) } : {}) },
    });
    await logAudit(req.userId!, "STORE_UPDATED", "Store", store.id, `Updated store ${store.name}`);
    res.json(toStoreDto(store));
  } catch {
    res.status(404).json({ error: "Store not found" });
  }
});

storesRouter.delete("/:id", async (req, res) => {
  try {
    const store = await prisma.store.delete({ where: { id: req.params.id } });
    await logAudit(req.userId!, "STORE_DELETED", "Store", store.id, `Deleted store ${store.name}`);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "Store not found" });
  }
});

storesRouter.post("/:id/test-connection", async (req, res) => {
  const store = await prisma.store.findUnique({ where: { id: req.params.id } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  const result = await testShopifyConnection(store);
  res.json(result);
});

storesRouter.post("/:id/sync-now", async (req, res) => {
  const store = await prisma.store.findUnique({ where: { id: req.params.id } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  try {
    const result = await syncCatalog(store.id);
    if (result.removedCount > 0) {
      await logAudit(
        req.userId!,
        "STORE_UPDATED",
        "Store",
        store.id,
        `Catalog sync removed ${result.removedCount} stale product row(s) no longer in Shopify for ${store.name}`
      );
    }
    if (store.salesAnalyticsEnabled) {
      await syncOrders(store.id);
      await syncPageViews(store.id);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : "Sync failed" });
  }
});
