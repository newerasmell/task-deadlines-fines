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

// --- Exact-product selection on search-results pages ---------------------
//
// A search results page commonly lists several sibling products (e.g.
// "Spicebomb", "Spicebomb Extreme", "Spicebomb Infrared", "Spicebomb Night
// Vision") and — when it embeds JSON-LD at all — often embeds one Product
// block per listed card, or an ItemList wrapping them. `tryJsonLd` above
// just takes whichever Product block appears first, with no check that it's
// actually the product we searched for. Confirmed live (zivada.hr) that
// this can silently record a sibling variant's price under our product.
//
// The fix: collect every candidate on the page, score each by how closely
// its title matches ours (symmetric token-set difference — fewer extra AND
// fewer missing words wins), and let the caller navigate to the best
// candidate's own product page rather than trusting the listing price.

export interface ProductCandidate {
  title: string;
  url: string | null;
  price: number | null;
}

function collectFromJsonLdNode(item: unknown, out: ProductCandidate[]): void {
  if (!item || typeof item !== "object") return;
  const node = item as Record<string, unknown>;
  const type = node["@type"];
  const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (isProduct) {
    const offersRaw = node.offers;
    const offers = (Array.isArray(offersRaw) ? offersRaw[0] : offersRaw) as Record<string, unknown> | undefined;
    const raw = offers?.price ?? offers?.lowPrice;
    const price = typeof raw === "string" ? parseFloat(raw.replace(",", ".")) : Number(raw);
    out.push({
      title: typeof node.name === "string" ? node.name : "",
      url: (typeof node.url === "string" ? node.url : null) ?? (typeof offers?.url === "string" ? offers.url : null),
      price: !Number.isNaN(price) && price > 0 ? price : null,
    });
    return;
  }
  // ItemList (typical on category/search pages): each entry either wraps a
  // Product directly under `.item`, or is itself a bare Product-shaped node.
  if (type === "ItemList" && Array.isArray(node.itemListElement)) {
    for (const el of node.itemListElement as unknown[]) {
      const elNode = el as Record<string, unknown>;
      collectFromJsonLdNode(elNode?.item ?? el, out);
    }
  }
}

export function collectJsonLdProducts(html: string): ProductCandidate[] {
  const found: ProductCandidate[] = [];
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of roots) {
        const graph = (node as Record<string, unknown>)["@graph"];
        const items = Array.isArray(graph) ? graph : [node];
        for (const item of items) collectFromJsonLdNode(item, found);
      }
    } catch {
      // Not valid/expected JSON-LD — ignore and keep scanning other blocks.
    }
  }
  return found;
}

const MATCH_STOP_TOKENS = new Set(["ml", "spray", "vaporisateur", "za", "for", "the"]);

function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return new Set(
    normalized.split(/\s+/).filter((t) => t.length > 1 && !MATCH_STOP_TOKENS.has(t) && !/^\d+$/.test(t))
  );
}

// Picks the candidate whose title is textually closest to ours — fewest
// words present in one title but not the other. A sibling variant like
// "Spicebomb Extreme" has one extra word ("extreme") versus the plain
// "Spicebomb" we searched for, so it scores worse than the exact match.
// Requires at least one shared word so we never "match" something wholly
// unrelated just because every candidate scored equally badly.
export function pickBestCandidate(ourTitle: string, candidates: ProductCandidate[]): ProductCandidate | null {
  const ourTokens = tokenize(ourTitle);
  let best: ProductCandidate | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (!candidate.title) continue;
    const candidateTokens = tokenize(candidate.title);
    let shared = 0;
    let diff = 0;
    for (const t of ourTokens) (candidateTokens.has(t) ? shared++ : diff++);
    for (const t of candidateTokens) if (!ourTokens.has(t)) diff++;
    if (shared === 0) continue;
    if (diff < bestScore) {
      bestScore = diff;
      best = candidate;
    }
  }
  return best;
}

export function extractMlFromTitle(title: string): number | null {
  const match = title.match(/(\d+(?:[.,]\d+)?)\s*ml\b/i);
  if (!match) return null;
  const ml = parseFloat(match[1].replace(",", "."));
  return Number.isNaN(ml) ? null : ml;
}

// Best-effort scan for a product page's own size/price variant picker (e.g.
// "50 ml ... 40,89 €", "90 ml ... 51,60 €", "150 ml ... 106,3 €" as separate
// buttons). Not backed by structured data — HTML structure for these
// pickers varies per site — so this only takes an exact ml match within a
// short character window of the ml label, and the caller always has
// extractPriceFromHtml()'s JSON-LD/meta price as a fallback if it finds
// nothing.
const ML_VARIANT_PATTERN = /(\d+(?:[.,]\d+)?)\s*ml\b([\s\S]{0,300}?)(\d{1,4}[.,]\d{2})\s*(?:€|eur)/gi;

export function extractVariantPrice(html: string, targetMl: number): number | null {
  for (const m of html.matchAll(ML_VARIANT_PATTERN)) {
    const ml = parseFloat(m[1].replace(",", "."));
    if (Math.abs(ml - targetMl) < 0.5) {
      const price = parseFloat(m[3].replace(",", "."));
      if (!Number.isNaN(price) && price > 0) return price;
    }
  }
  return null;
}
