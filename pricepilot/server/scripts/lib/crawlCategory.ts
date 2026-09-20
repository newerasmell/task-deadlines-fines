import type { SiteFetcher } from "./fetch";
import { sleep } from "./fetch";
import type { Listing, SiteConfig } from "./types";

// Same detect-by-diffing approach as jeftinijeScraper.ts's
// detectPageParam(): try the pagination params real sites actually use,
// pick whichever one's page 2 comes back with a genuinely different
// product set from page 1.
const PAGE_PARAM_CANDIDATES = ["page", "p", "strana", "stran", "oldal", "sel", "f"];

async function detectPageParam(
  fetcher: SiteFetcher,
  site: SiteConfig,
  baseUrl: string,
  firstPageListings: Listing[]
): Promise<string | null> {
  const sep = baseUrl.includes("?") ? "&" : "?";
  const firstUrls = new Set(firstPageListings.map((l) => l.url));
  for (const param of PAGE_PARAM_CANDIDATES) {
    const testUrl = `${baseUrl}${sep}${param}=2`;
    await sleep(1200);
    let html: string;
    try {
      html = await fetcher.get(testUrl);
    } catch {
      continue;
    }
    const listings = site.extractListings(html, testUrl);
    const urls = new Set(listings.map((l) => l.url));
    const different = listings.length > 0 && (urls.size !== firstUrls.size || [...urls].some((u) => !firstUrls.has(u)));
    if (different) return `${sep}${param}={n}`;
  }
  return null;
}

const CONSECUTIVE_FAILURE_LIMIT = 5;
const MAX_PAGES_PER_CATEGORY = 200;

export interface CrawlStats {
  pagesFetched: number;
  listingsFound: number;
}

// Crawls every category URL in site.categoryUrls (first page, then
// auto-paginating), calling site.extractListings() on each page's HTML.
// Same shape as buildJeftinijeIndex(): polite delay between requests, a
// consecutive-failure circuit breaker so a block/rate-limit aborts loudly
// instead of grinding through every remaining page, one shared listing
// array returned for the caller to match locally afterward.
export async function crawlSite(fetcher: SiteFetcher, site: SiteConfig): Promise<{ listings: Listing[]; stats: CrawlStats }> {
  const out: Listing[] = [];
  const stats: CrawlStats = { pagesFetched: 0, listingsFound: 0 };
  let consecutiveFailures = 0;

  for (const categoryUrl of site.categoryUrls) {
    console.log(`[${site.id}] category: ${categoryUrl}`);
    let html: string;
    try {
      if (stats.pagesFetched > 0) await sleep(1200);
      html = await fetcher.get(categoryUrl);
      stats.pagesFetched++;
    } catch (err) {
      consecutiveFailures++;
      console.warn(`[${site.id}] page 1 unreachable: ${categoryUrl} (${err instanceof Error ? err.message : err})`);
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        throw new Error(
          `${site.label} rejected ${CONSECUTIVE_FAILURE_LIMIT} consecutive requests — it's likely blocking this script. Aborted after ${stats.pagesFetched} pages (${out.length} listings collected before the block).`
        );
      }
      continue;
    }
    consecutiveFailures = 0;

    const firstListings = site.extractListings(html, categoryUrl);
    out.push(...firstListings);
    stats.listingsFound += firstListings.length;
    console.log(`[${site.id}]   page 1: ${firstListings.length} listings`);

    const pageFmt = await detectPageParam(fetcher, site, categoryUrl, firstListings);
    if (!pageFmt) continue;

    let prevUrls = new Set(firstListings.map((l) => l.url));
    for (let n = 2; n <= MAX_PAGES_PER_CATEGORY; n++) {
      // pageFmt already carries its own leading separator (e.g. "&page={n}"
      // or "?page={n}"), computed from this same categoryUrl in
      // detectPageParam() above — just substitute the page number.
      const finalUrl = `${categoryUrl}${pageFmt.replace("{n}", String(n))}`;
      await sleep(1200);
      let pageHtml: string;
      try {
        pageHtml = await fetcher.get(finalUrl);
        stats.pagesFetched++;
      } catch (err) {
        consecutiveFailures++;
        console.warn(`[${site.id}]   page ${n} unreachable (${err instanceof Error ? err.message : err})`);
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          throw new Error(
            `${site.label} rejected ${CONSECUTIVE_FAILURE_LIMIT} consecutive requests — it's likely blocking this script. Aborted after ${stats.pagesFetched} pages (${out.length} listings collected before the block).`
          );
        }
        break;
      }
      consecutiveFailures = 0;
      const listings = site.extractListings(pageHtml, finalUrl);
      const urls = new Set(listings.map((l) => l.url));
      const same = urls.size === prevUrls.size && [...urls].every((u) => prevUrls.has(u));
      if (listings.length === 0 || same) {
        console.log(`[${site.id}]   page ${n}: empty/repeat — stopping this category`);
        break;
      }
      out.push(...listings);
      stats.listingsFound += listings.length;
      console.log(`[${site.id}]   page ${n}: ${listings.length} listings`);
      prevUrls = urls;
    }
  }

  return { listings: out, stats };
}
