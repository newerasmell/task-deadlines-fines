import type { Product, Source, Store } from "@prisma/client";
import { BrowserSession } from "../lib/browserFetch";
import {
  collectJsonLdProducts,
  extractMlFromTitle,
  extractPriceFromHtml,
  extractVariantPrice,
  pickBestCandidate,
} from "../lib/htmlPriceParser";
import { politeDelay, politeGet } from "../lib/httpClient";
import { prisma } from "../lib/prisma";
import { buildFallbackMatchKey, normalizeBarcode } from "../lib/textNormalize";
import { refreshJeftinijeSource } from "./jeftinijeSource";
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

// Shopify product titles usually already include the brand ("Chanel No 5
// EDP 100ml"), so blindly prepending vendor produced garbled, doubled-up
// queries like "Chanel Chanel No 5 EDP 100ml" — plausibly why a source with
// literal/exact search matching (no fuzzy fallback) can come back with zero
// results for products that clearly exist there. Only prepend the vendor
// when the title doesn't already start with it.
function buildSearchQuery(vendor: string | null, title: string): string {
  const trimmedVendor = (vendor ?? "").trim();
  if (!trimmedVendor) return title.trim();
  const alreadyIncluded = title.trim().toLowerCase().startsWith(trimmedVendor.toLowerCase());
  return (alreadyIncluded ? title : `${trimmedVendor} ${title}`).trim();
}

// Shared by the live scraper below and the manual-import route (a Cowork
// agent researches sites by hand and uploads a filled-in CSV export
// template instead of us fetching the page ourselves) — both need the
// exact same write semantics, hysteresis included, so there's one place
// that decides what "found" and "not found" actually do to the DB.
export async function recordFoundPrice(params: {
  source: Source;
  store: Store;
  product: Product;
  price: number;
  url: string;
}): Promise<void> {
  const { source, store, product, price, url } = params;
  const matchKey = product.barcode
    ? normalizeBarcode(product.barcode)
    : buildFallbackMatchKey(product.vendor, product.title);
  await upsertCompetitorPrice({
    sourceId: source.id,
    productId: product.id,
    matchKey,
    competitorTitle: product.title,
    competitorSku: product.sku,
    competitorBarcode: product.barcode,
    price,
    currency: store.currency,
    url,
  });
  await upsertScrapeAttempt({ sourceId: source.id, productId: product.id, found: true, price, error: null, url });
}

// A confirmed "no price here" is meaningful evidence a previously-matched
// price is stale — but only once it's happened twice in a row (checking the
// PRIOR attempt, not yet overwritten, before deciding to clear). Confirmed
// live that requiring just one was too aggressive: a real match could
// flicker away because a single run caught the page mid-load, not because
// the product actually stopped being listed there.
export async function recordNotFound(params: {
  sourceId: string;
  productId: string;
  url: string;
  error: string;
}): Promise<void> {
  const { sourceId, productId, url, error } = params;
  const previous = await prisma.scrapeAttempt.findUnique({ where: { sourceId_productId: { sourceId, productId } } });
  if (previous && !previous.found) {
    await prisma.competitorPrice.deleteMany({ where: { sourceId, productId } });
  }
  await upsertScrapeAttempt({ sourceId, productId, found: false, price: null, error, url });
}

export function buildSearchUrl(template: string, product: Product): string {
  // Only take the EAN path if the template actually has an {EAN}
  // placeholder to fill — otherwise (e.g. a template that only defines
  // {QUERY}, which every source added so far uses) this used to leave
  // {QUERY} sitting in the URL completely unreplaced for any product that
  // happened to have a barcode, since .replace("{EAN}", …) is a silent
  // no-op when there's nothing to match.
  if (product.barcode && template.includes("{EAN}")) {
    return template.replace("{EAN}", encodeURIComponent(product.barcode));
  }
  const query = buildSearchQuery(product.vendor, product.title);
  return template.replace("{QUERY}", encodeURIComponent(query)).replace("{EAN}", "");
}

async function refreshScrapeSource(store: Store, source: Source): Promise<{ matched: number; attempted: number }> {
  if (!source.searchUrlTemplate) return { matched: 0, attempted: 0 };

  const products = await prisma.product.findMany({ where: { storeId: store.id } });
  const targets = pickScrapeTargets(products);

  // Real (headless) browser rather than a plain fetch(): some competitor
  // sites block non-browser HTTP clients outright via TLS/header
  // fingerprinting no amount of manually-set headers can fix. Scoped to
  // this one run (launched lazily on first use below, closed in the
  // `finally` at the bottom) rather than a shared long-lived instance —
  // Chromium can use 150-300MB+ RAM, real pressure on a small hosting plan,
  // so it's only paid for while a refresh is actually in progress.
  const browser = new BrowserSession();

  let matched = 0;
  try {
    for (const product of targets) {
      const url = buildSearchUrl(source.searchUrlTemplate, product);
      try {
        const html = await browser.get(url);
        let result = extractPriceFromHtml(html);
        let resultUrl = url;

        // A search-results page usually lists several sibling products
        // ("Spicebomb", "Spicebomb Extreme", "Spicebomb Infrared", ...).
        // extractPriceFromHtml() above just grabbed whichever JSON-LD
        // Product block happened to appear first, with no guarantee it's
        // the one we actually searched for — confirmed live it can record
        // a sibling variant's price under our product. Instead: collect
        // every listed candidate, pick the one whose title is the closest
        // textual match to ours, then visit THAT product's own page (which
        // also lets us read its exact size/price variants rather than
        // whatever the listing's default/starting price was).
        const candidates = collectJsonLdProducts(html);
        if (candidates.length > 0) {
          const query = buildSearchQuery(product.vendor, product.title);
          const best = pickBestCandidate(query, candidates);
          if (best?.url) {
            try {
              const detailUrl = new URL(best.url, url).toString();
              await politeDelay();
              const detailHtml = await browser.get(detailUrl);
              const targetMl = extractMlFromTitle(product.title);
              const variantPrice = targetMl != null ? extractVariantPrice(detailHtml, targetMl) : null;
              const detailPrice = variantPrice ?? extractPriceFromHtml(detailHtml)?.price ?? null;
              if (detailPrice != null) {
                result = { price: detailPrice, url: detailUrl };
                resultUrl = detailUrl;
              }
            } catch {
              // Detail page fetch/parse failed — fall back to whatever the
              // search results page itself yielded above.
            }
          }
        }

        if (result) {
          // The actual product page when we navigated to one, not the
          // search results listing — lets the user click through and see
          // exactly what was matched, rather than a results grid.
          await recordFoundPrice({ source, store, product, price: result.price, url: result.url ?? resultUrl });
          matched++;
        } else {
          await recordNotFound({
            sourceId: source.id,
            productId: product.id,
            url,
            error: "No price found on the page",
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
  } finally {
    await browser.close();
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

// `triggeredBy` is who clicked "Refresh now" — omitted (→ null) when the
// 15-min scheduler tick called this automatically, so the Sources UI can
// tell "you did this at 14:02" apart from "this ran on its own".
export async function refreshSource(
  sourceId: string,
  triggeredBy?: string
): Promise<{ ok: boolean; matched: number; error?: string }> {
  if (inFlight.has(sourceId)) {
    return { ok: false, matched: 0, error: "Already refreshing" };
  }
  inFlight.add(sourceId);
  try {
    const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId }, include: { store: true } });

    // manual_import sources have no live fetch to run — prices come in
    // through POST /sources/:id/import (a Cowork agent's research, applied
    // by hand). The scheduler and "Refresh now" don't distinguish source
    // types before calling this, so this just no-ops rather than treating
    // the missing searchUrlTemplate as a failure and marking it degraded.
    if (source.type === "manual_import") {
      return { ok: true, matched: source.lastMatchedCount ?? 0 };
    }

    try {
      let matched: number;
      if (source.type === "shopify_json") {
        matched = await refreshShopifyJsonSource(source.store, source);
      } else if (source.type === "jeftinije_hr") {
        matched = (await refreshJeftinijeSource(source.store, source)).matched;
      } else {
        matched = (await refreshScrapeSource(source.store, source)).matched;
      }

      await prisma.source.update({
        where: { id: sourceId },
        data: {
          lastRefreshedAt: new Date(),
          lastTriggeredBy: triggeredBy ?? null,
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
          lastTriggeredBy: triggeredBy ?? null,
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
