import { basename, dirname, join } from "path";
import { buildMatchIndex, matchProduct } from "../../src/lib/jeftinijeMatcher";
import { crawlSite } from "./crawlCategory";
import { SiteFetcher } from "./fetch";
import { loadProducts, writeAmbiguousCsv, writeResultsCsv } from "./productsCsv";
import type { AmbiguousRow, MatchedRow, SiteConfig } from "./types";

// CLI entrypoint every scripts/sites/*.ts calls at its bottom:
//   npx tsx scripts/sites/heureka-cz.ts <input.csv> [outDir]
// <input.csv> is PricePilot's own manual_import "Download template" export
// for the store being priced against this site. outDir defaults to
// scripts/out/ (see .gitkeep there — its contents are gitignored).
export async function runSite(site: SiteConfig): Promise<void> {
  const [, , inputCsv, outDirArg] = process.argv;
  if (!inputCsv) {
    console.error(`Usage: npx tsx scripts/sites/${site.id}.ts <input.csv> [outDir]`);
    process.exitCode = 1;
    return;
  }
  const outDir = outDirArg ?? join(dirname(inputCsv), "..", "out");
  const inputLabel = basename(inputCsv);

  if (site.categoryUrls.length === 0) {
    console.error(`[${site.id}] categoryUrls is empty — fill it in before running (see scripts/lib/types.ts).`);
    process.exitCode = 1;
    return;
  }

  const products = loadProducts(inputCsv);
  console.log(`[${site.id}] loaded ${products.length} products from ${inputLabel}`);

  const fetcher = new SiteFetcher(site);
  let listings;
  try {
    const crawl = await crawlSite(fetcher, site);
    listings = crawl.listings;
    console.log(`[${site.id}] crawl done: ${crawl.stats.pagesFetched} pages, ${crawl.stats.listingsFound} listings`);
  } finally {
    await fetcher.close();
  }

  const index = buildMatchIndex(listings);
  const results: MatchedRow[] = [];
  const ambiguous: AmbiguousRow[] = [];
  let foundCount = 0;
  let ambiguousCount = 0;
  let notFoundCount = 0;

  for (const product of products) {
    const result = matchProduct({ title: product.title, vendor: product.vendor || null }, index);
    if (result.status === "found") {
      foundCount++;
      results.push({
        ...product,
        competitorPrice: result.price,
        competitorUrl: result.url,
        notFound: false,
      });
    } else if (result.status === "ambiguous") {
      ambiguousCount++;
      results.push({ ...product, competitorPrice: null, competitorUrl: null, notFound: true });
      for (const c of result.candidates) {
        ambiguous.push({ productId: product.productId, candidateTitle: c.title, candidateUrl: c.url, candidatePrice: c.price });
      }
    } else {
      notFoundCount++;
      results.push({ ...product, competitorPrice: null, competitorUrl: null, notFound: true });
    }
  }

  const resultsPath = join(outDir, `${site.id}-results.csv`);
  writeResultsCsv(resultsPath, results);
  console.log(`[${site.id}] wrote ${results.length} rows to ${resultsPath}`);

  if (ambiguous.length > 0) {
    const ambiguousPath = join(outDir, `${site.id}-ambiguous.csv`);
    writeAmbiguousCsv(ambiguousPath, ambiguous);
    console.log(`[${site.id}] wrote ${ambiguous.length} candidate rows to ${ambiguousPath}`);
  }

  console.log(`[${site.id}] summary: found=${foundCount} ambiguous=${ambiguousCount} not_found=${notFoundCount}`);
}
