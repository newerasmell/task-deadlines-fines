// Best-effort, site-agnostic price extraction for `scrape`-type sources.
// No per-site CSS selectors (out of scope for the pilot per the brief) —
// tries the structured signals most e-commerce sites already expose.
// Returns null (rather than guessing) when nothing usable is found; the
// caller treats that as a failed fetch for the degraded-source counter.
//
// This used to also fall back to a plain-text currency scan when neither
// structured signal was present — deliberately removed, not just left
// unused: confirmed live it produces false positives, not just missed
// matches. On a genuine "no results found" page (zero matching products),
// it still grabbed some unrelated price-shaped number elsewhere on the page — a
// shipping-threshold banner, a recommended-item price, a filter widget —
// and reported it as a confirmed competitor price. That fed straight into
// the suggestion engine, which recommended dropping a real ~€199-235
// product to €139 based on a fabricated "€15 competitor price" it never
// actually saw. A false "no price found" costs coverage; a false price
// costs the user money if they trust and publish it — asymmetric enough
// that only structured, site-authored product-price signals (JSON-LD,
// price meta tags) are trusted to confirm an actual match.

interface ParsedPrice {
  price: number;
  url?: string;
}

function tryJsonLd(html: string): ParsedPrice | null {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of candidates) {
        const graph = node["@graph"] ? node["@graph"] : [node];
        for (const item of graph) {
          if (item?.["@type"] === "Product" || (Array.isArray(item?.["@type"]) && item["@type"].includes("Product"))) {
            const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
            const raw = offers?.price ?? offers?.lowPrice;
            const price = typeof raw === "string" ? parseFloat(raw.replace(",", ".")) : Number(raw);
            if (!Number.isNaN(price) && price > 0) return { price, url: item.url };
          }
        }
      }
    } catch {
      // Not valid/expected JSON-LD — ignore and keep scanning other blocks.
    }
  }
  return null;
}

const META_PATTERNS = [
  /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([\d.,]+)["']/i,
  /<meta[^>]+property=["']og:price:amount["'][^>]+content=["']([\d.,]+)["']/i,
  /<meta[^>]+itemprop=["']price["'][^>]+content=["']([\d.,]+)["']/i,
  /<[^>]+itemprop=["']price["'][^>]+content=["']([\d.,]+)["']/i,
];

function tryMetaTags(html: string): ParsedPrice | null {
  for (const pattern of META_PATTERNS) {
    const match = html.match(pattern);
    if (match) {
      const price = parseFloat(match[1].replace(",", "."));
      if (!Number.isNaN(price) && price > 0) return { price };
    }
  }
  return null;
}

export function extractPriceFromHtml(html: string): ParsedPrice | null {
  return tryJsonLd(html) ?? tryMetaTags(html);
}
