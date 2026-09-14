import type { Product, Source, Store } from "@prisma/client";
import { extractPriceFromHtml } from "../lib/htmlPriceParser";
import { politeDelay, politeGet } from "../lib/httpClient";
import { prisma } from "../lib/prisma";
import { buildFallbackMatchKey, normalizeBarcode } from "../lib/textNormalize";
import { resolveMatchesForStore } from "./matching";

const DEGRADE_AFTER_FAILURES = 3;
const MAX_JSON_PAGES = 40; // 40 * 250 = 10,000 products cap, generous for a pilot
const PRIORITY_TOP_N_BY_VALUE = 20;
const ROTATION_BUCKETS = 7; // non-priority products cycle across ~a week of daily runs

async function upsertCompetitorPrice(params: {
  sourceId: string;
  productId: string | null;
  matchKey: string;
  competitorTitle: string | null;
  competitorSku: string | null;
  competitorBarcode: string | null;
  price: number;
  currency: string;
  url: string | null;
}) {
  const now = new Date();
  await prisma.competitorPrice.upsert({
    where: { sourceId_matchKey: { sourceId: params.sourceId, matchKey: params.matchKey } },
    create: { ...params, fetchedAt: now },
    update: { ...params, fetchedAt: now },
  });
  await prisma.competitorPriceHistory.create({
    data: { sourceId: params.sourceId, matchKey: params.matchKey, price: params.price, fetchedAt: now },
  });
  const history = await prisma.competitorPriceHistory.findMany({
    where: { sourceId: params.sourceId, matchKey: params.matchKey },
    orderBy: { fetchedAt: "desc" },
    skip: 30,
    select: { id: true },
  });
  if (history.length > 0) {
    await prisma.competitorPriceHistory.deleteMany({ where: { id: { in: history.map((h) => h.id) } } });
  }
}

async function upsertScrapeAttempt(params: {
  sourceId: string;
  productId: string;
  found: boolean;
  price: number | null;
  error: string | null;
  url: string;
}) {
  const { sourceId, productId, ...rest } = params;
  await prisma.scrapeAttempt.upsert({
    where: { sourceId_productId: { sourceId, productId } },
    create: { sourceId, productId, ...rest, attemptedAt: new Date() },
    update: { ...rest, attemptedAt: new Date() },
  });
}

interface ShopifyJsonVariant {
  id: number;
  sku: string | null;
  price: string;
  compare_at_price: string | null;
  barcode?: string | null;
}
interface ShopifyJsonProduct {
  id: number;
  title: string;
  vendor: string | null;
  variants: ShopifyJsonVariant[];
}

async function refreshShopifyJsonSource(store: Store, source: Source): Promise<number> {
  let matched = 0;
  for (let page = 1; page <= MAX_JSON_PAGES; page++) {
    const url = `${source.baseUrl.replace(/\/$/, "")}/products.json?limit=250&page=${page}`;
    const body = await politeGet(url);
    const parsed = JSON.parse(body) as { products: ShopifyJsonProduct[] };
    if (!parsed.products || parsed.products.length === 0) break;

    for (const product of parsed.products) {
      for (const variant of product.variants) {
        const price = Number(variant.price);
        if (Number.isNaN(price)) continue;
        const matchKey = variant.barcode
          ? normalizeBarcode(variant.barcode)
          : buildFallbackMatchKey(product.vendor, product.title);

        await upsertCompetitorPrice({
          sourceId: source.id,
          productId: null, // resolved in bulk by resolveMatchesForStore afterward
          matchKey,
          competitorTitle: product.title,
          competitorSku: variant.sku,
          competitorBarcode: variant.barcode ?? null,
          price,
          currency: store.currency,
          url: `${source.baseUrl.replace(/\/$/, "")}/products/${product.id}`,
        });
        matched++;
      }
    }

    if (parsed.products.length < 250) break;
  }
  return matched;
}

function pickScrapeTargets(products: Product[]): Product[] {
  const byValueDesc = [...products].sort(
    (a, b) => b.price * (b.inventoryQuantity ?? 0) - a.price * (a.inventoryQuantity ?? 0)
  );
  const topByValue = new Set(byValueDesc.slice(0, PRIORITY_TOP_N_BY_VALUE).map((p) => p.id));
  const priority = products.filter((p) => p.priority || topByValue.has(p.id));

  const todaysBucket = new Date().getDay() % ROTATION_BUCKETS;
  const rest = products.filter((p) => !p.priority && !topByValue.has(p.id));
  const rotated = rest.filter((p) => hashToBucket(p.id) === todaysBucket);

  return [...priority, ...rotated];
}

function hashToBucket(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % ROTATION_BUCKETS;
}

function buildSearchUrl(template: string, product: Product): string {
  // Only take the EAN path if the template actually has an {EAN}
  // placeholder to fill — otherwise (e.g. a template that only defines
  // {QUERY}, which every source added so far uses) this used to leave
  // {QUERY} sitting in the URL completely unreplaced for any product that
  // happened to have a barcode, since .replace("{EAN}", …) is a silent
  // no-op when there's nothing to match.
  if (product.barcode && template.includes("{EAN}")) {
    return template.replace("{EAN}", encodeURIComponent(product.barcode));
  }
  const query = `${product.vendor ?? ""} ${product.title}`.trim();
  return template.replace("{QUERY}", encodeURIComponent(query)).replace("{EAN}", "");
}

async function refreshScrapeSource(store: Store, source: Source): Promise<{ matched: number; attempted: number }> {
  if (!source.searchUrlTemplate) return { matched: 0, attempted: 0 };

  const products = await prisma.product.findMany({ where: { storeId: store.id } });
  const targets = pickScrapeTargets(products);

  let matched = 0;
  for (const product of targets) {
    const url = buildSearchUrl(source.searchUrlTemplate, product);
    try {
      const html = await politeGet(url);
      const result = extractPriceFromHtml(html);
      if (result) {
        const matchKey = product.barcode
          ? normalizeBarcode(product.barcode)
          : buildFallbackMatchKey(product.vendor, product.title);
        await upsertCompetitorPrice({
          sourceId: source.id,
          productId: product.id, // we searched FOR this exact product, so it's already known
          matchKey,
          competitorTitle: product.title,
          competitorSku: product.sku,
          competitorBarcode: product.barcode,
          price: result.price,
          currency: store.currency,
          url: result.url ?? url,
        });
        matched++;
        await upsertScrapeAttempt({
          sourceId: source.id,
          productId: product.id,
          found: true,
          price: result.price,
          error: null,
          url,
        });
      } else {
        await upsertScrapeAttempt({
          sourceId: source.id,
          productId: product.id,
          found: false,
          price: null,
          error: "No price found on the page",
          url,
        });
      }
    } catch (err) {
      // One failed target shouldn't abort the whole run — the source-level
      // degraded flag is driven by refreshSource's own try/catch below.
      await upsertScrapeAttempt({
        sourceId: source.id,
        productId: product.id,
        found: false,
        price: null,
        error: err instanceof Error ? err.message : "Unknown error",
        url,
      });
    }
    await politeDelay();
  }
  return { matched, attempted: targets.length };
}

// A scrape refresh can walk ~140 products at a polite ~2-3s each — several
// minutes, far longer than an HTTP request/proxy should be held open for.
// Callers that need "fire and forget" behavior (the /refresh route) check
// this instead of awaiting refreshSource() directly; the DB row (updated
// below regardless of outcome) is the actual source of truth a client polls.
const inFlight = new Set<string>();

export function isSourceRefreshing(sourceId: string): boolean {
  return inFlight.has(sourceId);
}

export async function refreshSource(sourceId: string): Promise<{ ok: boolean; matched: number; error?: string }> {
  if (inFlight.has(sourceId)) {
    return { ok: false, matched: 0, error: "Already refreshing" };
  }
  inFlight.add(sourceId);
  try {
    const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId }, include: { store: true } });

    try {
      const matched =
        source.type === "shopify_json"
          ? await refreshShopifyJsonSource(source.store, source)
          : (await refreshScrapeSource(source.store, source)).matched;

      await prisma.source.update({
        where: { id: sourceId },
        data: {
          lastRefreshedAt: new Date(),
          lastMatchedCount: matched,
          consecutiveFailures: 0,
          degraded: false,
          lastError: null,
        },
      });
      await resolveMatchesForStore(source.storeId);
      return { ok: true, matched };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const failures = source.consecutiveFailures + 1;
      await prisma.source.update({
        where: { id: sourceId },
        data: {
          lastRefreshedAt: new Date(),
          lastMatchedCount: 0,
          consecutiveFailures: failures,
          degraded: failures >= DEGRADE_AFTER_FAILURES,
          lastError: message,
        },
      });
      return { ok: false, matched: 0, error: message };
    }
  } finally {
    inFlight.delete(sourceId);
  }
}

export async function refreshAllActiveSources(storeId?: string): Promise<void> {
  const sources = await prisma.source.findMany({ where: { active: true, ...(storeId ? { storeId } : {}) } });
  for (const source of sources) {
    await refreshSource(source.id);
  }
}
