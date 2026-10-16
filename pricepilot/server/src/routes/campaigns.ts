import { Router } from "express";
import { z } from "zod";
import { logAudit } from "../lib/audit";
import { prisma } from "../lib/prisma";
import { revertCampaign, startCampaign } from "../services/campaignEngine";

export const campaignsRouter = Router();

// Lightweight product list for the Campaigns page's own filters (stock,
// recent-sales, tags) — deliberately NOT routes/pricing.ts's response,
// which also computes competitor suggestions this page has no use for.
campaignsRouter.get("/:storeId/products", async (req, res) => {
  const store = await prisma.store.findUnique({ where: { id: req.params.storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  const [products, productCategories, categories] = await Promise.all([
    prisma.product.findMany({
      where: { storeId: store.id },
      orderBy: { title: "asc" },
      include: { sales: true },
    }),
    prisma.productCategory.findMany({ where: { product: { storeId: store.id } } }),
    prisma.category.findMany({ where: { storeId: store.id }, select: { id: true, title: true } }),
  ]);

  const categoryIdsByProduct = new Map<string, string[]>();
  for (const pc of productCategories) {
    const list = categoryIdsByProduct.get(pc.productId) ?? [];
    list.push(pc.categoryId);
    categoryIdsByProduct.set(pc.productId, list);
  }

  res.json({
    products: products.map((p) => ({
      productId: p.id,
      title: p.title,
      variantTitle: p.variantTitle,
      vendor: p.vendor,
      sku: p.sku,
      imageUrl: p.imageUrl,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      inventoryQuantity: p.inventoryQuantity,
      tags: p.tags ? p.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      categoryIds: categoryIdsByProduct.get(p.id) ?? [],
      unitsSold20d: p.sales?.unitsSold20d ?? null,
    })),
    categories: categories.map((c) => ({ categoryId: c.id, title: c.title })),
  });
});

campaignsRouter.get("/:storeId", async (req, res) => {
  const store = await prisma.store.findUnique({ where: { id: req.params.storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  const campaigns = await prisma.campaign.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { publishLogs: true } }, createdBy: { select: { id: true, name: true } } },
  });

  res.json(
    campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      campaignType: c.campaignType,
      discountPct: c.discountPct,
      startedAt: c.startedAt,
      endsAt: c.endsAt,
      status: c.status,
      revertedAt: c.revertedAt,
      itemCount: c._count.publishLogs,
      createdByName: c.createdBy?.name ?? null,
    }))
  );
});

const startCampaignSchema = z.object({
  storeId: z.string().min(1),
  name: z.string().min(1),
  campaignType: z.string().min(1),
  discountPct: z.number().positive().max(95),
  durationDays: z.number().int().positive().max(365),
  productIds: z.array(z.string().min(1)).min(1),
});

campaignsRouter.post("/", async (req, res) => {
  const parsed = startCampaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const store = await prisma.store.findUnique({ where: { id: parsed.data.storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  const { campaignId, results } = await startCampaign(store, {
    name: parsed.data.name,
    campaignType: parsed.data.campaignType,
    discountPct: parsed.data.discountPct,
    durationDays: parsed.data.durationDays,
    productIds: parsed.data.productIds,
    createdById: req.userId ?? null,
  });

  const successCount = results.filter((r) => r.status === "SUCCESS").length;
  const failCount = results.length - successCount;
  await logAudit(
    req.userId ?? null,
    "CAMPAIGN_STARTED",
    "Campaign",
    campaignId,
    `Started campaign "${parsed.data.name}" (${parsed.data.discountPct}% off, ${parsed.data.durationDays}d) on ${store.name}: ${successCount} item(s)${failCount > 0 ? `, ${failCount} failed` : ""}`
  );

  res.json({ campaignId, results });
});

campaignsRouter.post("/:id/revert", async (req, res) => {
  const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id }, include: { store: true } });
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const { results } = await revertCampaign(campaign.store, campaign.id);
  const successCount = results.filter((r) => r.status === "SUCCESS").length;
  const failCount = results.length - successCount;
  await logAudit(
    req.userId ?? null,
    "CAMPAIGN_REVERTED",
    "Campaign",
    campaign.id,
    `Reverted campaign "${campaign.name}" on ${campaign.store.name}: ${successCount} item(s)${failCount > 0 ? `, ${failCount} failed` : ""}`
  );

  res.json({ results });
});
