import type { Product, Source, Store } from "@prisma/client";
import { BRAND_IDS, buildJeftinijeIndex } from "../lib/jeftinijeScraper";
import { buildMatchIndex, canonBrand, matchProduct, type MatchCandidate } from "../lib/jeftinijeMatcher";
import { prisma } from "../lib/prisma";
import { recordFoundPrice, recordNotFound } from "./competitorCollection";

// Only the brand filters the store's own catalog actually needs — crawling
// all of BRAND_IDS regardless of what's on the shelf was making a full run
// take hours for a catalog that only carries a handful of them. Canonicalized
// through the same alias table the matcher uses (e.g. a catalog vendor of
// "Yves Saint Laurent" needs to pull in the "YSL" jeftinije.hr filter id).
function brandsCarriedByCatalog(products: { vendor: string | null }[]): string[] {
  const carried = new Set(products.map((p) => canonBrand(p.vendor ?? "")).filter(Boolean));
  return Object.keys(BRAND_IDS).filter((brand) => carried.has(canonBrand(brand)));
}

// One bulk crawl of jeftinije.hr's tracked brands, then strict local
// matching against every product in the store — unlike the per-product
// `scrape` source, this never visits a page per product, so it isn't
// subject to the same priority/rotation scheduling.
//
// Matching happens PER BRAND, right after that brand's own listings finish
// crawling, rather than once at the very end for the whole run — confirmed
// live that the crawl can be OOM-killed by Render partway through the full
// brand list, and a mid-crawl kill previously lost every result since
// nothing was written to the database until the entire thing finished.
// This way, whatever brands were already fully crawled have their matches
// already persisted even if a later brand's crawl is what gets killed.
export async function refreshJeftinijeSource(store: Store, source: Source): Promise<{ matched: number; ambiguous: number }> {
  const products = await prisma.product.findMany({ where: { storeId: store.id } });
  const brands = brandsCarriedByCatalog(products);
  if (brands.length === 0) {
    console.warn(
      "[jeftinije] no catalog vendor matched a tracked brand — check Product.vendor spelling against BRAND_IDS in jeftinijeScraper.ts"
    );
  }

  const productsByBrand = new Map<string, Product[]>();
  for (const product of products) {
    const brand = canonBrand(product.vendor ?? "");
    if (!brand) continue;
    const list = productsByBrand.get(brand) ?? [];
    list.push(product);
    productsByBrand.set(brand, list);
  }

  let matched = 0;
  let ambiguous = 0;

  await buildJeftinijeIndex(brands, async (brand, listings) => {
    const brandProducts = productsByBrand.get(canonBrand(brand)) ?? [];
    if (brandProducts.length === 0) return;
    const index = buildMatchIndex(listings);

    for (const product of brandProducts) {
      const result = matchProduct(product, index);

      if (result.status === "found") {
        await recordFoundPrice({ source, store, product, price: result.price, url: result.url });
        matched++;
      } else if (result.status === "ambiguous") {
        await upsertAmbiguousMatch(source.id, product, result.candidates);
        ambiguous++;
      } else {
        await recordNotFound({
          sourceId: source.id,
          productId: product.id,
          url: source.baseUrl,
          error: "No matching listing found on jeftinije.hr",
        });
      }
    }
    console.log(`[jeftinije] persisted brand=${brand}: ${brandProducts.length} products matched against ${listings.length} listings`);
  });

  return { matched, ambiguous };
}

// Leaves an already-resolved/dismissed row alone unless the candidate set
// actually changed — a re-run shouldn't re-litigate a decision the admin
// already made just because the crawl found the same handful of listings
// again.
async function upsertAmbiguousMatch(sourceId: string, product: Product, candidates: MatchCandidate[]): Promise<void> {
  const candidatesJson = JSON.stringify(candidates);
  const existing = await prisma.ambiguousMatch.findUnique({
    where: { sourceId_productId: { sourceId, productId: product.id } },
  });
  if (existing && existing.status !== "pending" && existing.candidatesJson === candidatesJson) {
    return;
  }
  await prisma.ambiguousMatch.upsert({
    where: { sourceId_productId: { sourceId, productId: product.id } },
    create: { sourceId, productId: product.id, candidatesJson, status: "pending" },
    update: { candidatesJson, status: "pending", resolvedAt: null },
  });
}
