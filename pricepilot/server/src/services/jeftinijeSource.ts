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
export async function refreshJeftinijeSource(store: Store, source: Source): Promise<{ matched: number; ambiguous: number }> {
  const products = await prisma.product.findMany({ where: { storeId: store.id } });
  const brands = brandsCarriedByCatalog(products);
  if (brands.length === 0) {
    console.warn(
      "[jeftinije] no catalog vendor matched a tracked brand — check Product.vendor spelling against BRAND_IDS in jeftinijeScraper.ts"
    );
  }

  const listings = await buildJeftinijeIndex(brands);
  const index = buildMatchIndex(listings);

  let matched = 0;
  let ambiguous = 0;

  for (const product of products) {
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
