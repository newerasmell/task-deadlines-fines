import * as cheerio from "cheerio";
import { canonBrand } from "../../src/lib/jeftinijeMatcher";
import { runSite } from "../lib/runSite";
import type { Listing, ProductRow, SiteConfig } from "../lib/types";

const BASE = "https://www.skroutz.gr";

// "81,61 €" — European comma-decimal, single price per listing (unlike
// Heureka.cz's multi-shop range) since each Skroutz card is one specific
// shop's offer, not an aggregate.
function parsePriceEur(text: string): number | null {
  const cleaned = text.replace(/ /g, " ").replace("€", "").trim().replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Confirmed live against a real skroutz.gr search page: each product sits
// in <li data-testid="sku-cardd" data-skuid="...">, with the title in
// a[data-testid="sku-title-link"] > h2 and the price in
// a[data-e2e-testid="sku-price-link"]. The card's own href is already a
// clean, permanent product URL (unlike Heureka.cz's exit-click tracking
// redirect) — just carries tracking query params (from, product_id,
// sponsored, stm) worth stripping since they're noise, not part of the
// product's identity.
export function extractListings(html: string, pageUrl: string): Listing[] {
  const $ = cheerio.load(html);
  const out: Listing[] = [];

  $('li[data-testid="sku-cardd"]').each((_, el) => {
    const $card = $(el);
    const $titleLink = $card.find('a[data-testid="sku-title-link"]').first();
    const title = $titleLink.find("h2").first().text().trim() || $titleLink.attr("title")?.trim() || "";
    if (!title) return;

    const priceText = $card.find('a[data-e2e-testid="sku-price-link"]').first().text();
    const price = parsePriceEur(priceText);
    if (price === null) return; // no live offer on this card

    const href = $titleLink.attr("href");
    if (!href) return;
    const url = new URL(href, pageUrl);
    url.search = ""; // drop ?from=...&product_id=...&sponsored=...&stm=... tracking noise
    url.hash = "";

    out.push({ title, url: url.toString(), priceEur: price });
  });

  return out;
}

function categoryUrlsForBrands(products: ProductRow[]): string[] {
  const brands = new Set<string>();
  for (const p of products) {
    const brand = canonBrand(p.vendor);
    if (brand) brands.add(brand);
  }
  return [...brands].sort().map((brand) => `${BASE}/search?keyphrase=${encodeURIComponent(brand)}`);
}

export const skroutzGr: SiteConfig = {
  id: "skroutz-gr",
  label: "Skroutz.gr",
  baseUrl: BASE,
  categoryUrls: [],
  categoryUrlsFor: categoryUrlsForBrands,
  locale: "el-GR",
  // Site sits behind Cloudflare (confirmed live: a plain GET gets the
  // "Just a moment..." challenge page, same as jeftinije.hr and
  // Heureka.cz) — needs the real browser.
  needsBrowser: true,
  extractListings,
};

runSite(skroutzGr);
