import { Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { computeSuggestion } from "../services/suggestionEngine";
import {
  computeK,
  compareFromPrice,
  flagForPrice,
  parseScenarios,
  pickScenario,
  priceFromCost,
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

    const sourcePrices: Record<string, { price: number; currency: string; url: string | null; fetchedAt: string; stale: boolean }> = {};
    for (const m of matches) {
      sourcePrices[m.sourceId] = {
        price: m.price,
        currency: m.currency,
        url: m.url,
        fetchedAt: m.fetchedAt.toISOString(),
        stale: now - m.fetchedAt.getTime() > STALE_AFTER_MS,
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
  const [products, costs, config] = await Promise.all([
    prisma.product.findMany({ where: { storeId: store.id }, orderBy: { title: "asc" } }),
    prisma.cost.findMany({ where: { storeId: store.id } }),
    prisma.codFormulaConfig.upsert({ where: { storeId: store.id }, create: { storeId: store.id }, update: {} }),
  ]);

  const costBySkuOrEan = new Map(costs.map((c) => [c.skuOrEan, c.cost]));
  const costFor = (product: (typeof products)[number]): number | null =>
    (product.sku ? costBySkuOrEan.get(product.sku) : undefined) ??
    (product.barcode ? costBySkuOrEan.get(product.barcode) : undefined) ??
    null;

  const knownCosts = products.map(costFor).filter((c): c is number => c != null);
  const avgCost = knownCosts.length > 0 ? knownCosts.reduce((a, b) => a + b, 0) / knownCosts.length : 0;

  const scenarios = parseScenarios(config);
  const scenario = pickScenario(scenarios, config.pricingScenario);
  const { k, reason } = computeK(config, avgCost, scenario);

  const rows = products.map((product) => {
    const cost = costFor(product);
    const recommendedPrice = cost != null ? priceFromCost(cost, k, config.roundStep) : null;
    const recommendedComparePrice = compareFromPrice(recommendedPrice, config.discountPct);
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
