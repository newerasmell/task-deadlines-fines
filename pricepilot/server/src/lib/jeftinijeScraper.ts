// Bulk index of jeftinije.hr's perfumery listings for a fixed set of
// brands — a TS port of the standalone scrape_jeftinije.py workaround the
// user already had running by hand. One-shot crawl of the brand-filtered
// listing pages (not a per-product search), so a single run covers every
// tracked brand's whole catalog there; matching against our own products
// happens afterward in jeftinijeMatcher.ts.
import * as cheerio from "cheerio";
import { BrowserSession, type PersistentPage } from "./browserFetch";
import { sleep } from "./httpClient";

const BASE = "https://www.jeftinije.hr";

// Perfumery L3 categories to crawl (id, slug) — see the site's own nav.
const CATEGORIES: { id: number; slug: string }[] = [
  { id: 949, slug: "ljepota-i-zdravlje/parfumerija/parfemi" },
  { id: 951, slug: "ljepota-i-zdravlje/parfumerija/toaletne-vode" },
  { id: 952, slug: "ljepota-i-zdravlje/parfumerija/ostali-mirisi" },
];

// Brand -> jeftinije.hr pbra filter IDs (some brands exist under more than
// one id). Harvested from the live brand filter on L3/949 — extend freely
// by opening the Parfemi category, finding the brand in the left filter,
// and copying the number after ?pbra=.
export const BRAND_IDS: Record<string, number[]> = {
  AMOUAGE: [58777],
  ARMANI: [45566, 26504, 51710],
  BVLGARI: [18080, 49597],
  "CAROLINA HERRERA": [26462],
  CHANEL: [26464],
  DIOR: [45480, 26469],
  GUCCI: [26509],
  GUERLAIN: [26510],
  "JEAN PAUL GAULTIER": [26525],
  LANCOME: [26545],
  "LOUIS VUITTON": [62901],
  "PACO RABANNE": [26575, 133802],
  "TOM FORD": [26601],
  XERJOFF: [67549],
  YSL: [26617, 46327],
  MONTALE: [61412],
  "BY KILIAN": [69254, 61657],
  "DOLCE & GABBANA": [26483, 7098],
  CREED: [26476],
  HERMES: [26517],
  "HUGO BOSS": [26519, 4164],
  "MAISON FRANCIS KURKDJIAN": [71114],
  VERSACE: [4856],
  BURBERRY: [26459],
  "ESTEE LAUDER": [48296],
  MANCERA: [64488, 108998],
  "NARCISO RODRIGUEZ": [26567],
  SOSPIRO: [69271],
  "THIERRY MUGLER": [26600, 98645],
  "TIZIANA TERENZI": [64508],
  GIVENCHY: [26506],
  "ORTO PARISI": [122009],
  VALENTINO: [26610],
  NISHANE: [118897],
  "VIKTOR & ROLF": [26614],
  "JO MALONE": [69270],
  MEMO: [63784],
  "ZADIG & VOLTAIRE": [87457],
};

export interface JeftinijeListing {
  title: string;
  url: string;
  priceEur: number | null;
}

const PRICE_RE = /(\d{1,4}(?:\.\d{3})*(?:,\d{1,2})|\d{1,4}(?:[.,]\d{1,2})?)\s*€/;

function parsePrice(text: string): number | null {
  const m = PRICE_RE.exec(text);
  if (!m) return null;
  let raw = m[1];
  if (raw.includes(",") && raw.includes(".")) raw = raw.replace(/\./g, "").replace(",", "."); // 1.234,56
  else if (raw.includes(",")) raw = raw.replace(",", "."); // 96,50
  const num = Number(raw);
  return Number.isNaN(num) ? null : Math.round(num * 100) / 100;
}

// Finds product cards on a listing/search page: anchors to /Proizvod/<id>/,
// with the price read from the nearest ancestor that contains one (climbs
// up to 6 levels, mirroring the Python version's DOM-climb heuristic).
export function extractProducts(html: string, pageUrl: string): JeftinijeListing[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: JeftinijeListing[] = [];

  $('a[href*="/Proizvod/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href || !/\/Proizvod\/\d+\//.test(href)) return;
    const url = (href.startsWith("http") ? href : BASE + href).split("?")[0];
    const title = $a.text().trim() || $a.attr("title") || "";
    if (!title || title.length <= 3) return;

    let node = $a;
    let price: number | null = null;
    for (let hops = 0; hops < 6 && price === null; hops++) {
      if (hops > 0) price = parsePrice(node.text());
      const parent = node.parent();
      if (parent.length === 0) break;
      // Stop before climbing into a container that holds more than one
      // product card — past that point "nearest ancestor with a €" starts
      // reading a sibling card's price instead of this one's.
      if (parent.find('a[href*="/Proizvod/"]').length > 1) break;
      node = parent;
    }

    const key = `${url}|${title}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ title, url, priceEur: price });
    }
  });
  return out;
}

// jeftinije.hr 403s a plain HTTP client outright — confirmed live, same
// TLS/header fingerprinting douglas.hr already forced a real-browser fetch
// for (see browserFetch.ts) — so this crawl goes through a real headless
// Chromium. Uses ONE PersistentPage (shared cookies) for the whole crawl,
// not a fresh incognito context per request: confirmed live that a
// cookie-less "new visitor" on every single navigation — including page 2
// of a listing a real visitor just paginated into from page 1 — gets 403'd
// on requests that succeed fine opened by hand, where a hand-opened browser
// naturally carries session continuity across pages.
async function fetchWithRetry(page: PersistentPage, url: string): Promise<string | null> {
  let lastMessage = "unknown error";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.goto(url);
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      if (lastMessage.includes("403") || lastMessage.includes("429")) {
        await sleep(30000);
      } else {
        await sleep(5000);
      }
    }
  }
  console.warn(`[jeftinije] giving up on ${url} after 3 attempts: ${lastMessage}`);
  return null;
}

// Tries the pagination param jeftinije.hr actually uses (?p=, ?page=, or
// ?stran=) by comparing page 2's product set against page 1's — same
// detect-by-diffing approach as the Python version, since the working
// param isn't guaranteed the same across every listing.
async function detectPageParam(
  page: PersistentPage,
  baseUrl: string,
  firstPageProducts: JeftinijeListing[]
): Promise<string | null> {
  const sep = baseUrl.includes("?") ? "&" : "?";
  const firstUrls = new Set(firstPageProducts.map((p) => p.url));
  for (const param of ["p", "page", "stran"]) {
    const testUrl = `${baseUrl}${sep}${param}=2`;
    await sleep(1200);
    const html = await fetchWithRetry(page, testUrl);
    if (!html) continue;
    const products = extractProducts(html, testUrl);
    const urls = new Set(products.map((p) => p.url));
    const different = products.length > 0 && (urls.size !== firstUrls.size || [...urls].some((u) => !firstUrls.has(u)));
    if (different) return `${sep}${param}={n}`;
  }
  return null;
}

// Returns whether the listing's first page was reachable at all — lets the
// caller tell "this one listing had no pages" apart from "the site stopped
// answering us", which is the signal a run-wide circuit breaker needs.
async function crawlListing(page: PersistentPage, baseUrl: string, out: JeftinijeListing[]): Promise<boolean> {
  const first = await fetchWithRetry(page, baseUrl);
  if (!first) return false;
  const firstProducts = extractProducts(first, baseUrl);
  out.push(...firstProducts);

  const pageFmt = await detectPageParam(page, baseUrl, firstProducts);
  if (!pageFmt) return true;

  let prevUrls = new Set(firstProducts.map((p) => p.url));
  for (let n = 2; n <= 200; n++) {
    const url = `${baseUrl}${pageFmt.replace("{n}", String(n))}`;
    await sleep(1200);
    const html = await fetchWithRetry(page, url);
    if (!html) break;
    const products = extractProducts(html, url);
    const urls = new Set(products.map((p) => p.url));
    const same = urls.size === prevUrls.size && [...urls].every((u) => prevUrls.has(u));
    if (products.length === 0 || same) break;
    out.push(...products);
    prevUrls = urls;
  }
  return true;
}

// A real block (bot detection, IP ban) fails every request the same way —
// without this, a blocked run would silently retry all ~150 listing pages
// for hours (3 attempts x up to 30s backoff each) before ever surfacing an
// error. Abort as soon as that pattern shows up instead of grinding through
// the rest of the brand list.
const CONSECUTIVE_FAILURE_LIMIT = 5;

// Crawls every category for every id of every brand in `brands` (defaults
// to all of BRAND_IDS) and returns the combined listing — ~150-250 pages
// for the full brand list, several minutes at the polite pace.
export async function buildJeftinijeIndex(brands: string[] = Object.keys(BRAND_IDS)): Promise<JeftinijeListing[]> {
  const out: JeftinijeListing[] = [];
  let consecutiveFailures = 0;
  let attempted = 0;
  console.log(`[jeftinije] starting crawl: ${brands.length} brands x ${CATEGORIES.length} categories`);

  // One headless Chromium AND one persistent page/context (cookies kept)
  // for the entire crawl — launched lazily on first use, closed below.
  const browser = new BrowserSession();
  try {
    const page = await browser.newPersistentPage();
    try {
      for (const category of CATEGORIES) {
        const categoryBase = `${BASE}/L3/${category.id}/${category.slug}`;
        for (const brand of brands) {
          const ids = BRAND_IDS[brand];
          if (!ids) continue;
          for (const pbra of ids) {
            if (attempted > 0) await sleep(1200);
            attempted++;
            const ok = await crawlListing(page, `${categoryBase}?pbra=${pbra}`, out);
            if (!ok) {
              consecutiveFailures++;
              console.warn(
                `[jeftinije] listing unreachable: brand=${brand} pbra=${pbra} category=${category.slug} (${consecutiveFailures} in a row)`
              );
              if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
                throw new Error(
                  `jeftinije.hr rejected ${CONSECUTIVE_FAILURE_LIMIT} consecutive requests — it's likely blocking this server. Aborted after ${attempted} of ~${brands.length * CATEGORIES.length} listing pages (${out.length} products collected before the block).`
                );
              }
            } else {
              consecutiveFailures = 0;
            }
          }
        }
      }
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`[jeftinije] crawl finished: ${out.length} products from ${attempted} listing pages`);
  return out;
}
