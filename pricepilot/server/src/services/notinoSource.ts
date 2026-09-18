import type { Product, Source, Store } from "@prisma/client";
import { BRAND_SLUGS, buildNotinoIndex } from "../lib/notinoScraper";
import { buildMatchIndex, canonBrand, matchProduct, type MatchCandidate } from "../lib/jeftinijeMatcher";
import { prisma } from "../lib/prisma";
import { recordFoundPrice, recordNotFound } from "./competitorCollection";

// Same brand+ml+concentration+model-token matcher jeftinije.hr uses —
// NotinoListing is structurally the same shape (title/url/priceEur) as
// JeftinijeListing, so nothing site-specific needs re-implementing here.
function brandsCarriedByCatalog(products: { vendor: string | null }[]): string[] {
  const carried = new Set(products.map((p) => canonBrand(p.vendor ?? "")).filter(Boolean));
  return Object.keys(BRAND_SLUGS).filter((brand) => carried.has(canonBrand(brand)));
}

// Mirrors refreshJeftinijeSource(): matches and persists each brand's
// results immediately once that brand's own crawl completes, rather than
// waiting for the whole (currently 1-brand) run to finish — same
// incremental-save reasoning, kept even though a single-brand test run is
// unlikely to need it, so this scales the same way once more brands are
// added to BRAND_SLUGS.
export async function refreshNotinoSource(store: Store, source: Source): Promise<{ matched: number; ambiguous: number }> {
  const products = await prisma.product.findMany({ where: { storeId: store.id } });
  const brands = brandsCarriedByCatalog(products);
  if (brands.length === 0) {
    console.warn(
      "[notino] no catalog vendor matched a tracked brand — check Product.vendor spelling against BRAND_SLUGS in notinoScraper.ts"
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

  await buildNotinoIndex(brands, async (brand, listings) => {
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
          error: "No matching listing found on notino.hr",
        });
      }
    }
    console.log(`[notino] persisted brand=${brand}: ${brandProducts.length} products matched against ${listings.length} listings`);
  });

  return { matched, ambiguous };
}

// Identical "leave alone unless changed" rule as jeftinijeSource.ts.
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
