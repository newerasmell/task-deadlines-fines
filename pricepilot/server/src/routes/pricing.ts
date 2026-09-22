import { Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { computeSuggestion } from "../services/suggestionEngine";
import {
  computeK,
  flagForPrice,
  parseScenarios,
  pickScenario,
  priceFromCost,
  rawBasePriceFromCoefficient,
  roundCharmPrice,
} from "../services/codPricingEngine";

export const pricingRouter = Router();

const priorityToggleSchema = z.object({ priority: z.boolean() });

pricingRouter.patch("/product/:id/priority", async (req, res) => {
  const parsed = priorityToggleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const product = await prisma.product.update({ where: { id: req.params.id }, data: { priority: parsed.data.priority } });
    res.json({ id: product.id, priority: product.priority });
  } catch {
    res.status(404).json({ error: "Product not found" });
  }
});

const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

pricingRouter.get("/:storeId", async (req, res) => {
  const store = await prisma.store.findUnique({ where: { id: req.params.storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  if (store.pricingProfile === "cod_formula") {
    return sendCodPricingTable(res, store);
  }

  const [products, sources, costs] = await Promise.all([
    prisma.product.findMany({ where: { storeId: store.id }, orderBy: { title: "asc" } }),
    prisma.source.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "asc" } }),
    prisma.cost.findMany({ where: { storeId: store.id } }),
  ]);

  const activeSourceIds = new Set(sources.filter((s) => s.active).map((s) => s.id));
  const competitorPrices = await prisma.competitorPrice.findMany({
    where: { sourceId: { in: sources.map((s) => s.id) }, productId: { in: products.map((p) => p.id) } },
  });

  const costBySkuOrEan = new Map(costs.map((c) => [c.skuOrEan, c.cost]));
  const compByProduct = new Map<string, typeof competitorPrices>();
  for (const cp of competitorPrices) {
    if (!cp.productId) continue;
    const list = compByProduct.get(cp.productId) ?? [];
    list.push(cp);
    compByProduct.set(cp.productId, list);
  }

  const now = Date.now();
  const rule = {
    strategy: store.pricingStrategy as "undercut_min" | "match_min" | "undercut_avg",
    undercutPct: store.undercutPct,
    priceEnding: store.priceEnding,
    minMarginPct: store.minMarginPct,
  };

  const rows = products.map((product) => {
    const matches = compByProduct.get(product.id) ?? [];
    const activeMatches = matches.filter((m) => activeSourceIds.has(m.sourceId));
    const cost =
      (product.sku ? costBySkuOrEan.get(product.sku) : undefined) ??
      (product.barcode ? costBySkuOrEan.get(product.barcode) : undefined) ??
      null;

    const suggestion = computeSuggestion({
      ourPrice: product.price,
      competitorPrices: activeMatches.map((m) => m.price),
      cost,
      rule,
      noCostFloorPct: env.noCostFloorPct,
    });

    const sourcePrices: Record<
      string,
      { price: number; currency: string; url: string | null; fetchedAt: string; stale: boolean; isManual: boolean }
    > = {};
    for (const m of matches) {
      sourcePrices[m.sourceId] = {
        price: m.price,
        currency: m.currency,
        url: m.url,
        fetchedAt: m.fetchedAt.toISOString(),
        stale: now - m.fetchedAt.getTime() > STALE_AFTER_MS,
        isManual: m.isManual,
      };
    }

    const deltaPct = suggestion.minComp != null ? ((product.price - suggestion.minComp) / suggestion.minComp) * 100 : null;

    return {
      productId: product.id,
      shopifyVariantId: product.shopifyVariantId,
      title: product.title,
      vendor: product.vendor,
      handle: product.handle,
      sku: product.sku,
      barcode: product.barcode,
      imageUrl: product.imageUrl,
      tags: product.tags ? product.tags.split(",") : [],
      cost,
      ourPrice: product.price,
      compareAtPrice: product.compareAtPrice,
      inventoryQuantity: product.inventoryQuantity,
      priority: product.priority,
      sourcePrices,
      matchedSourceCount: activeMatches.length,
      minComp: suggestion.minComp,
      avgComp: suggestion.avgComp,
      deltaPct,
      suggested: suggestion.suggested,
      recommendedComparePrice: null,
      floor: suggestion.floor,
      flag: suggestion.flag,
    };
  });

  res.json({
    sources: sources.map((s) => ({ id: s.id, label: s.label, active: s.active, degraded: s.degraded, lastRefreshedAt: s.lastRefreshedAt })),
    rows,
    formula: null,
  });
});

async function sendCodPricingTable(res: Response, store: { id: string; pricingProfile: string }) {
  const [products, costs, config, productCategories, brands] = await Promise.all([
    prisma.product.findMany({ where: { storeId: store.id }, orderBy: { title: "asc" } }),
    prisma.cost.findMany({ where: { storeId: store.id } }),
    prisma.codFormulaConfig.upsert({ where: { storeId: store.id }, create: { storeId: store.id }, update: {} }),
    // Covers two independent fallbacks: costFor below (a manually-set
    // category acquisition cost, for a product with no SKU/EAN row in
    // Cost) and basePriceFor below (a product's suggested base/compare-at
    // price, placed inside its category's manually-set min/max range).
    prisma.productCategory.findMany({
      where: { product: { storeId: store.id } },
      select: {
        productId: true,
        categoryId: true,
        category: { select: { baseMinPrice: true, baseMaxPrice: true, categoryCost: { select: { cost: true } } } },
      },
    }),
    prisma.brand.findMany({ where: { storeId: store.id } }),
  ]);

  const costBySkuOrEan = new Map(costs.map((c) => [c.skuOrEan, c.cost]));
  const categoryCostsByProduct = new Map<string, number[]>();
  const categoryIdsByProduct = new Map<string, string[]>();
  for (const pc of productCategories) {
    const idList = categoryIdsByProduct.get(pc.productId) ?? [];
    idList.push(pc.categoryId);
    categoryIdsByProduct.set(pc.productId, idList);

    if (pc.category.categoryCost == null) continue;
    const costList = categoryCostsByProduct.get(pc.productId) ?? [];
    costList.push(pc.category.categoryCost.cost);
    categoryCostsByProduct.set(pc.productId, costList);
  }

  const costFor = (product: (typeof products)[number]): { cost: number | null; fromCategory: boolean } => {
    const skuCost =
      (product.sku ? costBySkuOrEan.get(product.sku) : undefined) ??
      (product.barcode ? costBySkuOrEan.get(product.barcode) : undefined) ??
      null;
    if (skuCost != null) return { cost: skuCost, fromCategory: false };
    const catCosts = categoryCostsByProduct.get(product.id);
    if (catCosts && catCosts.length > 0) {
      // A product in more than one category with a cost set (rare, but
      // Shopify collections aren't mutually exclusive) averages them rather
      // than picking one arbitrarily.
      return { cost: catCosts.reduce((a, b) => a + b, 0) / catCosts.length, fromCategory: true };
    }
    return { cost: null, fromCategory: false };
  };

  const knownCosts = products.map((p) => costFor(p).cost).filter((c): c is number => c != null);
  const avgCost = knownCosts.length > 0 ? knownCosts.reduce((a, b) => a + b, 0) / knownCosts.length : 0;

  const scenarios = parseScenarios(config);
  const scenario = pickScenario(scenarios, config.pricingScenario);
  const { k, reason } = computeK(config, avgCost, scenario);

  // Per category with BOTH baseMinPrice and baseMaxPrice set: the min/max
  // coefficient among the brands that actually sell in it — the range the
  // coefficient normalization below (rawBasePriceFromCoefficient) is scaled
  // against, so a category is always spanned by the brands really in it,
  // not the store's full coefficient scale.
  const vendorById = new Map(products.map((p) => [p.id, p.vendor]));
  const coefficientByVendor = new Map(brands.map((b) => [b.vendor, b.coefficient]));
  const categoryVendorsById = new Map<string, Set<string>>();
  const categoryRangeById = new Map<string, { min: number; max: number }>();
  for (const pc of productCategories) {
    if (pc.category.baseMinPrice == null || pc.category.baseMaxPrice == null) continue;
    categoryRangeById.set(pc.categoryId, { min: pc.category.baseMinPrice, max: pc.category.baseMaxPrice });
    const vendor = vendorById.get(pc.productId);
    if (!vendor) continue;
    const set = categoryVendorsById.get(pc.categoryId) ?? new Set<string>();
    set.add(vendor);
    categoryVendorsById.set(pc.categoryId, set);
  }
  const categoryCoeffRangeById = new Map<string, { lo: number; hi: number }>();
  for (const [categoryId, vendors] of categoryVendorsById) {
    const coeffs = [...vendors].map((v) => coefficientByVendor.get(v)).filter((c): c is number => c != null);
    if (coeffs.length === 0) continue;
    categoryCoeffRangeById.set(categoryId, { lo: Math.min(...coeffs), hi: Math.max(...coeffs) });
  }

  // Null unless the product's own vendor has a coefficient AND at least one
  // of its categories has both a base-price range and its own resolvable
  // coefficient range — same "blank until configured" rule costFor uses for
  // acquisition cost, deliberately not falling back to the old flat
  // price/(1-discountPct) markup.
  const basePriceFor = (product: (typeof products)[number]): number | null => {
    if (!product.vendor) return null;
    const coefficient = coefficientByVendor.get(product.vendor);
    if (coefficient == null) return null;
    const categoryIds = categoryIdsByProduct.get(product.id) ?? [];
    const raws: number[] = [];
    for (const categoryId of categoryIds) {
      const range = categoryRangeById.get(categoryId);
      const coeffRange = categoryCoeffRangeById.get(categoryId);
      if (!range || !coeffRange) continue;
      raws.push(rawBasePriceFromCoefficient(range.min, range.max, coefficient, coeffRange.lo, coeffRange.hi));
    }
    if (raws.length === 0) return null;
    return roundCharmPrice(raws.reduce((a, b) => a + b, 0) / raws.length);
  };

  const rows = products.map((product) => {
    const { cost, fromCategory } = costFor(product);
    const recommendedPrice = cost != null ? priceFromCost(cost, k, config.roundStep) : null;
    const recommendedComparePrice = basePriceFor(product);
    const tags = product.tags ? product.tags.split(",").filter(Boolean) : [];
    const discountTagged = tags.some((t) => t.trim().toLowerCase() === config.discountTag.trim().toLowerCase());
    const deltaPct = recommendedPrice != null ? ((product.price - recommendedPrice) / recommendedPrice) * 100 : null;

    return {
      productId: product.id,
      shopifyVariantId: product.shopifyVariantId,
      title: product.title,
      vendor: product.vendor,
      handle: product.handle,
      sku: product.sku,
      barcode: product.barcode,
      imageUrl: product.imageUrl,
      tags,
      discountTagged,
      cost,
      costFromCategory: fromCategory,
      ourPrice: product.price,
      compareAtPrice: product.compareAtPrice,
      inventoryQuantity: product.inventoryQuantity,
      priority: product.priority,
      sourcePrices: {},
      matchedSourceCount: 0,
      minComp: null,
      avgComp: null,
      deltaPct,
      suggested: recommendedPrice,
      recommendedComparePrice,
      floor: recommendedPrice ?? 0,
      flag: cost == null ? "no-data" : flagForPrice(product.price, recommendedPrice),
    };
  });

  res.json({
    sources: [],
    rows,
    formula: { config, avgCost, k, reason, scenario: scenario.key },
  });
}
