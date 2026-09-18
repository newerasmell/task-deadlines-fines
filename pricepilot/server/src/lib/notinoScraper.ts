// Per-brand product-listing crawl of notino.hr — a second, much simpler
// competitor source than jeftinije.hr's, built as a small server-side test:
// does the same headless-browser approach survive a real crawl on a site
// that (unlike jeftinije.hr) isn't sitting behind a Cloudflare managed
// challenge? notino.hr's markup is a clean React app with stable
// `data-testid` attributes and an explicit `<link rel="next">` for
// pagination — no DOM-climbing or param-guessing needed like jeftinije.hr.
import * as cheerio from "cheerio";
import { BrowserSession, type PersistentPage } from "./browserFetch";
import { sleep } from "./httpClient";

const BASE = "https://www.notino.hr";

// Brand -> notino.hr URL slug. Unlike jeftinije.hr there's no separate
// numeric filter id to discover per brand — each brand already has its own
// landing page at /<slug>/, and pagination from there follows the page's
// own <link rel="next"> straight through. Starting with just DIOR for the
// first real test; add more slugs here once this is confirmed working.
export const BRAND_SLUGS: Record<string, string> = {
  DIOR: "dior",
};

export interface NotinoListing {
  title: string;
  url: string;
  priceEur: number | null;
}

// Croatian price format is comma-decimal ("61,90") with no thousands
// separator seen on these listing pages — simpler than jeftinije.hr's mix
// of "1.234,56" / "96,50", so no dot-vs-comma disambiguation needed.
function parsePrice(text: string): number | null {
  const num = Number(text.trim().replace(",", "."));
  return Number.isNaN(num) ? null : Math.round(num * 100) / 100;
}

// Each card carries brand/name/variant as three separate `data-testid`
// spans (confirmed live from a captured notino.hr/dior/ page) — joined into
// one title string so the existing jeftinije.hr matcher (brand + ml +
// concentration + model tokens, all extracted from free text) works on it
// unchanged.
export function extractProducts(html: string): NotinoListing[] {
  const $ = cheerio.load(html);
  const out: NotinoListing[] = [];
  $('[data-testid="product-container"]').each((_, el) => {
    const $card = $(el);
    const href = $card.find("a").first().attr("href") ?? "";
    if (!href) return;
    const url = href.startsWith("http") ? href : BASE + href;
    const brand = $card.find('[data-testid="product-card-brand"]').first().text().trim();
    const name = $card.find('[data-testid="product-card-name"]').first().text().trim();
    const variant = $card.find('[data-testid="product-card-variant-name"]').first().text().trim();
    const title = [brand, name, variant].filter(Boolean).join(" ");
    if (!title) return;
    const priceText = $card.find('[data-testid="price-component"]').first().text().trim();
    out.push({ title, url, priceEur: priceText ? parsePrice(priceText) : null });
  });
  return out;
}

// notino.hr's own pagination link — page 1 has no `f=` param at all, every
// later page gets an explicit `<link rel="next" href=".../?f=<page>-1-<id>">`
// confirmed live in a captured page, so there's nothing to detect/guess
// here unlike jeftinije.hr's ?p=/?page=/?stran= probing.
function findNextPageUrl(html: string): string | null {
  const $ = cheerio.load(html);
  const href = $('link[rel="next"]').attr("href");
  return href ? (href.startsWith("http") ? href : BASE + href) : null;
}

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
  console.warn(`[notino] giving up on ${url} after 3 attempts: ${lastMessage}`);
  return null;
}

// Same circuit-breaker idea as jeftinije.hr: abort rather than grind for
// hours if the connection is genuinely being blocked.
const CONSECUTIVE_FAILURE_LIMIT = 5;
// Safety cap in case a page's own `rel="next"` ever pointed back at itself
// or otherwise failed to terminate — no real brand catalog on notino.hr
// runs anywhere near 80 pages (pageSize 24/page confirmed live).
const MAX_PAGES_PER_BRAND = 80;

// Crawls every brand in `brands` (defaults to all of BRAND_SLUGS) via its
// own /<slug>/ landing page and <link rel="next"> pagination, firing
// `onBrandDone` once a brand's full listing is collected — same
// incremental-persistence hook as jeftinije.hr's buildJeftinijeIndex, so a
// crash partway through a multi-brand run still leaves earlier brands'
// results saved.
export async function buildNotinoIndex(
  brands: string[] = Object.keys(BRAND_SLUGS),
  onBrandDone?: (brand: string, listings: NotinoListing[]) => Promise<void>
): Promise<NotinoListing[]> {
  const out: NotinoListing[] = [];
  let consecutiveFailures = 0;
  let attempted = 0;
  console.log(`[notino] starting crawl: ${brands.length} brand(s)`);

  const browser = new BrowserSession();
  try {
    const page = await browser.newPersistentPage();
    try {
      for (const brand of brands) {
        const slug = BRAND_SLUGS[brand];
        if (!slug) continue;
        const brandListings: NotinoListing[] = [];
        let url: string | null = `${BASE}/${slug}/`;
        for (let pageNum = 0; url && pageNum < MAX_PAGES_PER_BRAND; pageNum++) {
          if (attempted > 0) await sleep(1200);
          attempted++;
          const html = await fetchWithRetry(page, url);
          if (!html) {
            consecutiveFailures++;
            console.warn(`[notino] page unreachable: brand=${brand} url=${url} (${consecutiveFailures} in a row)`);
            if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
              throw new Error(
                `notino.hr rejected ${CONSECUTIVE_FAILURE_LIMIT} consecutive requests — it's likely blocking this server. Aborted after ${attempted} pages (${out.length + brandListings.length} products collected before the block).`
              );
            }
            break; // give up on this brand, move to the next
          }
          consecutiveFailures = 0;
          brandListings.push(...extractProducts(html));
          url = findNextPageUrl(html);
        }
        out.push(...brandListings);
        // Only persist a brand whose crawl actually produced something —
        // calling onBrandDone with an empty list after every one of its
        // pages failed would have the caller record every one of that
        // brand's products as "not found on notino.hr", when the honest
        // state is "we couldn't reach the site", not "we looked and it's
        // not there".
        if (onBrandDone && brandListings.length > 0) await onBrandDone(brand, brandListings);
      }
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`[notino] crawl finished: ${out.length} products from ${attempted} pages`);
  return out;
}
