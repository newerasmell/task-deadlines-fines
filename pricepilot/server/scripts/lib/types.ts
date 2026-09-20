// Shared shapes for the standalone one-site-at-a-time crawler scripts
// (scripts/sites/*.ts) — see scripts/README.md for the whole pipeline.

// Same shape as JeftinijeListing in ../../src/lib/jeftinijeScraper.ts —
// deliberately, so these scripts can reuse matchProduct/buildMatchIndex
// from ../../src/lib/jeftinijeMatcher.ts as-is instead of duplicating ~200
// lines of brand/size/concentration matching logic that has nothing
// jeftinije-specific about it.
export interface Listing {
  title: string;
  url: string;
  priceEur: number | null;
}

// One row read from a PricePilot manual_import "Download template" CSV
// (see EXPORT_HEADER in server/src/routes/sources.ts) — this is the
// existing per-store product export the app already generates; these
// scripts consume it as their product list instead of hitting the API.
export interface ProductRow {
  productId: string;
  sku: string;
  vendor: string;
  title: string;
  sizeMl: string;
  ourPrice: string;
  searchUrl: string;
}

export interface MatchedRow extends ProductRow {
  competitorPrice: number | null;
  competitorUrl: string | null;
  notFound: boolean;
}

// One row of scripts/lib/runSite.ts's second output file — same shape the
// app's POST /sources/:id/import-ambiguous already understands, for
// products where more than one plausible listing turned up.
export interface AmbiguousRow {
  productId: string;
  candidateTitle: string;
  candidateUrl: string;
  candidatePrice: number | null;
}

export interface SiteConfig {
  // Short id used in default output filenames, e.g. "bazos-cz".
  id: string;
  label: string;
  baseUrl: string;
  // Perfumery/cosmetics category (or search) listing pages to crawl — one
  // run walks all of them, paginating each with crawlCategory(). Left as a
  // clearly-marked placeholder until real HTML confirms the real category
  // URLs and pagination scheme (see scripts/README.md).
  categoryUrls: string[];
  // BCP-47 locale for the fetcher's Accept-Language header / browser
  // context — matters for sites that serve different markup per locale.
  locale: string;
  // Whether this site needs a real (headless) browser rather than a plain
  // HTTP GET — defaults to true across all 7 sites until a real run proves
  // a given one doesn't need it (see browserFetch.ts's docstring: several
  // sites in this same codebase turned out to require this that didn't
  // look like they would going in).
  needsBrowser: boolean;
  // Site-specific: pull {title, url, priceEur}[] out of one listing page's
  // HTML. Throws until filled in against that site's real markup.
  extractListings: (html: string, pageUrl: string) => Listing[];
}
