// Best-effort, site-agnostic price extraction for `scrape`-type sources.
// No per-site CSS selectors (out of scope for the pilot per the brief) —
// tries, in order, the structured signals most e-commerce sites already
// expose, then falls back to a plain-text currency scan. Returns null
// (rather than guessing) when nothing usable is found; the caller treats
// that as a failed fetch for the degraded-source counter.

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

const CURRENCY_PATTERN = /(\d{1,6}[.,]\d{2})\s*(?:лв\.?|BGN|EUR|€|USD|\$|PLN|zł)|(?:лв\.?|BGN|EUR|€|USD|\$|PLN|zł)\s*(\d{1,6}[.,]\d{2})/i;

function tryCurrencyScan(html: string): ParsedPrice | null {
  // Strip script/style noise and cap the scan window so we're reading near
  // the top of the page (likely the main product block), not a "related
  // products" carousel further down.
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const window = cleaned.slice(0, 40000);
  const match = window.match(CURRENCY_PATTERN);
  if (!match) return null;
  const raw = match[1] ?? match[2];
  const price = parseFloat(raw.replace(",", "."));
  if (Number.isNaN(price) || price <= 0) return null;
  return { price };
}

export function extractPriceFromHtml(html: string): ParsedPrice | null {
  return tryJsonLd(html) ?? tryMetaTags(html) ?? tryCurrencyScan(html);
}
