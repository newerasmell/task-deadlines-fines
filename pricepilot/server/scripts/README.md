# Standalone competitor-crawl scripts

One script per competitor site (`scripts/sites/<site>.ts`), run by hand from
the command line. Unlike a live `Source` in the app, these don't write to the
database directly — each run reads a product list from a CSV, crawls the
site, and writes a CSV back in the exact format PricePilot's own
manual_import already understands. Nothing here runs on a schedule; you run
a script, review the output, then upload it.

## Usage

1. In PricePilot, open the store's `manual_import` source and click
   **Download template** — that's your `<input.csv>`. It already has one row
   per product with `product_id`, `sku`, `vendor`, `title`, `size_ml`,
   `our_price`.
2. Run the matching site script against it:
   ```
   cd pricepilot/server
   npx tsx scripts/sites/heureka-cz.ts /path/to/downloaded-template.csv
   ```
   Output goes to `scripts/out/<site-id>-results.csv` (and
   `<site-id>-ambiguous.csv` if any products had more than one plausible
   match) unless you pass a second argument for the output directory.
3. Upload `<site-id>-results.csv` back on that same manual_import source's
   **Import** button. If an ambiguous file was produced, upload it on
   **Import ambiguous matches** too — those show up in the review queue for
   a human to pick between.

## Before running a site for the first time

A `SiteConfig` gets its listing URLs one of two ways:

- **`categoryUrls: string[]`** — a hand-maintained static list. Ships empty;
  fill it in with real category/filter URLs before running a site that uses
  this (found by using the site's own brand/category filters and copying the
  resulting URL, not by guessing any internal filter-ID scheme).
- **`categoryUrlsFor(products)`** — built fresh on every run from whichever
  CSV you feed it, so it never goes stale as the store's catalog changes.
  Takes priority over `categoryUrls` when a site defines it. Heureka.cz uses
  this: it builds one `/f:q:<brand>/` free-text search URL per distinct
  brand in the input CSV (no site-specific numeric ID needed for that one).

Also double check `needsBrowser` and `locale` are right for that site before
a real run — see the comments on `SiteConfig` in `scripts/lib/types.ts`.

## Currency

These scripts don't convert currency. A site's script emits whatever
currency that site's prices are actually in (e.g. Heureka.cz emits raw CZK
numbers). That's correct as long as the CSV gets uploaded against a Store
configured with the matching currency (`Store.currency` in
`prisma/schema.prisma`) — never mix a non-EUR site's output into a
EUR-currency store's import.

## Shared infrastructure (`scripts/lib/`)

- `types.ts` — `Listing`, `SiteConfig`, CSV row shapes.
- `productsCsv.ts` — reads the manual_import template, writes both output
  CSV formats.
- `fetch.ts` — `SiteFetcher`: a plain locale-aware HTTP GET, or a real
  headless-browser session (via `../../src/lib/browserFetch.ts`) when
  `SiteConfig.needsBrowser` is true.
- `crawlCategory.ts` — `crawlSite()`: pages through every `categoryUrls`
  entry, auto-detecting the pagination query param, with a circuit breaker
  that aborts loudly if the site starts rejecting requests instead of
  grinding through a block.
- `runSite.ts` — the CLI entrypoint every `scripts/sites/*.ts` calls at its
  bottom: loads products, crawls, matches via
  `../../src/lib/jeftinijeMatcher.ts` (genuinely site-agnostic despite the
  name — strict brand+size+concentration matching, never a fuzzy guess),
  writes the output CSVs, prints a summary.
