import { Router } from "express";
import { z } from "zod";
import { logAudit } from "../lib/audit";
import { prisma } from "../lib/prisma";

export const salesRouter = Router();

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// avgSalePrice/convRate are always derived at read time from the two raw
// counters (revenue/units, units/views) rather than stored — they can never
// drift out of sync with the numbers they're computed from, and a zero
// denominator just means "no data" (null) instead of a division blow-up.
salesRouter.get("/:storeId", async (req, res) => {
  const store = await prisma.store.findUnique({ where: { id: req.params.storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  const [products, categories, productCategories] = await Promise.all([
    prisma.product.findMany({
      where: { storeId: store.id },
      orderBy: { title: "asc" },
      include: { sales: true, pageViews: true },
    }),
    prisma.category.findMany({ where: { storeId: store.id }, include: { categoryCost: true }, orderBy: { title: "asc" } }),
    prisma.productCategory.findMany({ where: { product: { storeId: store.id } } }),
  ]);

  const categoryIdsByProduct = new Map<string, string[]>();
  for (const pc of productCategories) {
    const list = categoryIdsByProduct.get(pc.productId) ?? [];
    list.push(pc.categoryId);
    categoryIdsByProduct.set(pc.productId, list);
  }

  const productRows = products.map((p) => {
    const unitsSold6m = p.sales?.unitsSold6m ?? 0;
    const revenue6m = p.sales?.revenue6m ?? 0;
    const pageViews6m = p.pageViews?.pageViews6m ?? null;
    return {
      productId: p.id,
      title: p.title,
      vendor: p.vendor,
      sku: p.sku,
      imageUrl: p.imageUrl,
      inventoryQuantity: p.inventoryQuantity,
      unitsSold6m,
      avgSalePrice6m: unitsSold6m > 0 ? round2(revenue6m / unitsSold6m) : null,
      pageViews6m,
      convRate6m: pageViews6m && pageViews6m > 0 ? round2((unitsSold6m / pageViews6m) * 100) : null,
      categoryIds: categoryIdsByProduct.get(p.id) ?? [],
    };
  });

  const productsByCategory = new Map<string, typeof productRows>();
  for (const row of productRows) {
    for (const categoryId of row.categoryIds) {
      const list = productsByCategory.get(categoryId) ?? [];
      list.push(row);
      productsByCategory.set(categoryId, list);
    }
  }

  const categoryRows = categories.map((c) => {
    const rows = productsByCategory.get(c.id) ?? [];
    const unitsSold6m = rows.reduce((sum, r) => sum + r.unitsSold6m, 0);
    const revenue6m = rows.reduce((sum, r) => sum + (r.avgSalePrice6m ?? 0) * r.unitsSold6m, 0);
    const pageViews6m = rows.some((r) => r.pageViews6m != null)
      ? rows.reduce((sum, r) => sum + (r.pageViews6m ?? 0), 0)
      : null;
    return {
      categoryId: c.id,
      title: c.title,
      productCount: rows.length,
      unitsSold6m,
      avgSalePrice6m: unitsSold6m > 0 ? round2(revenue6m / unitsSold6m) : null,
      pageViews6m,
      convRate6m: pageViews6m && pageViews6m > 0 ? round2((unitsSold6m / pageViews6m) * 100) : null,
      cost: c.categoryCost?.cost ?? null,
      currency: c.categoryCost?.currency ?? store.currency,
    };
  });

  res.json({
    salesAnalyticsEnabled: store.salesAnalyticsEnabled,
    pricingProfile: store.pricingProfile,
    currency: store.currency,
    products: productRows,
    categories: categoryRows,
  });
});

const categoryCostSchema = z.object({ cost: z.number().positive() });

salesRouter.put("/category/:categoryId/cost", async (req, res) => {
  const parsed = categoryCostSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const category = await prisma.category.findUnique({ where: { id: req.params.categoryId }, include: { store: true } });
  if (!category) return res.status(404).json({ error: "Category not found" });

  const categoryCost = await prisma.categoryCost.upsert({
    where: { categoryId: category.id },
    create: { categoryId: category.id, cost: parsed.data.cost, currency: category.store.currency },
    update: { cost: parsed.data.cost },
  });
  await logAudit(
    req.userId!,
    "CATEGORY_COST_UPDATED",
    "Category",
    category.id,
    `Set acquisition cost of "${category.title}" to ${parsed.data.cost} ${categoryCost.currency}`
  );
  res.json(categoryCost);
});

salesRouter.delete("/category/:categoryId/cost", async (req, res) => {
  const category = await prisma.category.findUnique({ where: { id: req.params.categoryId } });
  if (!category) return res.status(404).json({ error: "Category not found" });

  await prisma.categoryCost.deleteMany({ where: { categoryId: category.id } });
  await logAudit(req.userId!, "CATEGORY_COST_CLEARED", "Category", category.id, `Cleared acquisition cost of "${category.title}"`);
  res.json({ ok: true });
});
