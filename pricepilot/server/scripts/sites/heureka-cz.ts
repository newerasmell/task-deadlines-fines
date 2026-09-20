import * as cheerio from "cheerio";
import { runSite } from "../lib/runSite";
import type { Listing, SiteConfig } from "../lib/types";

const BASE = "https://parfemy.heureka.cz";

// "1 199 – 1 819 Kč" (Heureka aggregates several shops per product and shows
// their price range) or "1 595 Kč" (only one shop). &nbsp; is used as the
// thousands separator, confirmed live on a real category page. Empty text
// means the card has no live offer (sponsored slot / out of stock) — those
// are skipped entirely by the caller rather than treated as "not found".
function parsePriceKc(text: string): number | null {
  const cleaned = text.replace(/ /g, " ").replace(/Kč/i, "").trim();
  if (!cleaned) return null;
  const nums = cleaned
    .split(/[–-]/)
    .map((part) => Number(part.replace(/\s+/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;
  // The cheapest of the shops Heureka found this exact product at — the
  // real floor a customer could already buy it for today.
  return Math.min(...nums);
}

// Confirmed live against a real parfemy.heureka.cz category page (a
// brand-filtered one, e.g. /f:5371:158810;q:si/ = Armani "Sí" line):
// each product sits in <li data-testid="product-list-item">, with the
// title in a[data-testid="product-title-link"] and the price range in
// [data-testid="ProductPrice"]. Every card's click-through anchors point
// at Heureka's own "/exit-click-web?...&et=<encrypted>" tracking redirect
// (still a valid clickable link, just not a stable/pretty one); only
// products carrying reviews additionally expose Heureka's own clean
// canonical page via a[data-testid="star-rating-rating"] — preferred when
// present.
export function extractListings(html: string, pageUrl: string): Listing[] {
  const $ = cheerio.load(html);
  const out: Listing[] = [];

  $('li[data-testid="product-list-item"]').each((_, el) => {
    const $card = $(el);
    const $titleLink = $card.find('a[data-testid="product-title-link"]').first();
    const title = $titleLink.text().trim();
    if (!title) return;

    const priceKc = parsePriceKc($card.find('[data-testid="ProductPrice"]').first().text());
    if (priceKc === null) return; // no live offer on this card — nothing to compare against

    const cleanHref = $card.find('a[data-testid="star-rating-rating"]').first().attr("href");
    const trackingHref = $titleLink.attr("href");
    const rawHref = cleanHref ? cleanHref.split("#")[0] : trackingHref;
    if (!rawHref) return;
    const url = new URL(rawHref, pageUrl).toString();

    // Field is called priceEur for historical reasons (see Listing in
    // ../lib/types.ts) — it actually holds raw CZK here. That's correct as
    // long as this CSV is uploaded against a Store whose own currency is
    // CZK (Store.currency in schema.prisma), which is what makes the
    // numbers comparable on the PricePilot side; no conversion happens here.
    out.push({ title, url, priceEur: priceKc });
  });

  return out;
}

export const heurekaCz: SiteConfig = {
  id: "heureka-cz",
  label: "Heureka.cz",
  baseUrl: BASE,
  // Brand-filtered category pages, one per brand the store carries — e.g.
  // "https://parfemy.heureka.cz/f:5371:158810;q:si/" (Armani, "Sí" line).
  // Crawling the whole /parfemy.heureka.cz/ category instead would pull in
  // every brand's listings, most of them irrelevant to any one store's
  // catalog — fill this in with the store's actual carried brands before
  // running (see scripts/README.md for how to find each filter URL).
  categoryUrls: [],
  locale: "cs-CZ",
  // Page embeds Cloudflare's bot-management challenge-platform script
  // (window.__CF$cv$params) — a plain HTTP GET is likely to get a challenge
  // page instead of real content, so this goes through the real headless
  // browser like jeftinije.hr does. Flip to false only after confirming a
  // plain GET actually returns product markup.
  needsBrowser: true,
  extractListings,
};

runSite(heurekaCz);
