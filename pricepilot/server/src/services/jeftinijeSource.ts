import type { Product, Source, Store } from "@prisma/client";
import { buildJeftinijeIndex } from "../lib/jeftinijeScraper";
import { buildMatchIndex, matchProduct, type MatchCandidate } from "../lib/jeftinijeMatcher";
import { prisma } from "../lib/prisma";
import { recordFoundPrice, recordNotFound } from "./competitorCollection";

// One bulk crawl of jeftinije.hr's tracked brands, then strict local
// matching against every product in the store — unlike the per-product
// `scrape` source, this never visits a page per product, so it isn't
// subject to the same priority/rotation scheduling.
export async function refreshJeftinijeSource(store: Store, source: Source): Promise<{ matched: number; ambiguous: number }> {
  const listings = await buildJeftinijeIndex();
  const index = buildMatchIndex(listings);

  const products = await prisma.product.findMany({ where: { storeId: store.id } });

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
