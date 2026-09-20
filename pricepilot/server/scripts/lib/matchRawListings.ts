import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import { buildMatchIndex, matchProduct } from "../../src/lib/jeftinijeMatcher";
import { loadProducts, writeAmbiguousCsv, writeResultsCsv } from "./productsCsv";
import type { AmbiguousRow, Listing, MatchedRow } from "./types";

// Offline match step for raw listings gathered outside crawlSite() (e.g.
// scripts/local/scrape_heureka_cz.py's manually-assisted run) -- no network
// needed here, only the two CSVs already on disk. Reuses the exact same
// matching engine crawlSite-based sites use, so results are consistent
// either way a site's listings were collected.
//
// Usage:
//   npx tsx scripts/lib/matchRawListings.ts <raw-listings.csv> <products.csv> <site-id> [outDir]
//
// raw-listings.csv columns: vendor_searched, title, price_czk (or price), url
// products.csv: PricePilot's own manual_import "Download template" export

function loadRawListings(csvPath: string): Listing[] {
  const raw = readFileSync(csvPath, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  return rows
    .map((row) => {
      const title = (row.title ?? "").trim();
      const url = (row.url ?? "").trim();
      const priceRaw = row.price_czk ?? row.price ?? "";
      const price = priceRaw ? Number(priceRaw) : NaN;
      return { title, url, priceEur: Number.isFinite(price) ? price : null };
    })
    .filter((l) => l.title && l.url);
}

function main() {
  const [, , rawCsv, productsCsv, siteId, outDirArg] = process.argv;
  if (!rawCsv || !productsCsv || !siteId) {
    console.error("Usage: npx tsx scripts/lib/matchRawListings.ts <raw-listings.csv> <products.csv> <site-id> [outDir]");
    process.exitCode = 1;
    return;
  }
  const outDir = outDirArg ?? "scripts/out";

  const listings = loadRawListings(rawCsv);
  console.log(`[${siteId}] loaded ${listings.length} raw listings from ${rawCsv}`);

  const products = loadProducts(productsCsv);
  console.log(`[${siteId}] loaded ${products.length} products from ${productsCsv}`);

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
      results.push({ ...product, competitorPrice: result.price, competitorUrl: result.url, notFound: false });
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

  const resultsPath = `${outDir}/${siteId}-results.csv`;
  writeResultsCsv(resultsPath, results);
  console.log(`[${siteId}] wrote ${results.length} rows to ${resultsPath}`);

  if (ambiguous.length > 0) {
    const ambiguousPath = `${outDir}/${siteId}-ambiguous.csv`;
    writeAmbiguousCsv(ambiguousPath, ambiguous);
    console.log(`[${siteId}] wrote ${ambiguous.length} candidate rows to ${ambiguousPath}`);
  }

  console.log(`[${siteId}] summary: found=${foundCount} ambiguous=${ambiguousCount} not_found=${notFoundCount}`);
}

main();
