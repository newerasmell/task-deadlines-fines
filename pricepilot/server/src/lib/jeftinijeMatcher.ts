// Strict local matching of our catalog against a jeftinije.hr index — a TS
// port of match_products.py's rules. No fuzzy scoring: brand + exact ml +
// exact concentration class + full agreement on the model-name tokens
// (flanker guard: "Le Male" must never match "Le Male Elixir"). Anything
// short of that goes to the ambiguous queue instead of being guessed.
import { extractMl, normalizeText } from "./textNormalize";
import type { JeftinijeListing } from "./jeftinijeScraper";

// Longer/more specific phrases first so e.g. "eau de parfum" is caught
// before a bare "parfum" match would misfire on it.
const CONC_PATTERNS: [string, string[]][] = [
  ["EXTRAIT", ["extrait de parfum", "extrait", "esencia de parfum", "essence de parfum", "elixir de parfum"]],
  ["EDP", ["eau de parfum", "parfemska voda", "parfimirana voda", "edp", "parfumska voda", "parfemovana voda"]],
  ["EDT", ["eau de toilette", "toaletna voda", "edt", "toaletni voda"]],
  ["EDC", ["eau de cologne", "kolonjska voda", "edc", "cologne", "kolinska voda"]],
  ["PARFUM", ["parfum", "parfem"]], // last: bare "parfum" is a weak signal
];

const BRAND_ALIASES: Record<string, string> = {
  ysl: "yves saint laurent",
  "yves saint laurent": "yves saint laurent",
  armani: "armani",
  "giorgio armani": "armani",
  "emporio armani": "armani",
  dior: "dior",
  "christian dior": "dior",
  "paco rabanne": "paco rabanne",
  rabanne: "paco rabanne",
  bvlgari: "bvlgari",
  bulgari: "bvlgari",
  "d g": "dolce gabbana",
  "dolce gabbana": "dolce gabbana",
  "hugo boss": "hugo boss",
  boss: "hugo boss",
  "by kilian": "by kilian",
  kilian: "by kilian",
  killian: "by kilian",
  "thierry mugler": "mugler",
  mugler: "mugler",
  "estee lauder": "estee lauder",
  "maison francis kurkdjian": "mfk",
  mfk: "mfk",
  "jean paul gaultier": "jean paul gaultier",
  "viktor rolf": "viktor rolf",
  "zadig voltaire": "zadig voltaire",
  "jo malone": "jo malone",
  "jo malone london": "jo malone",
};

const GENERIC = new Set([
  "za", "muskarce", "zene", "musko", "zensko", "men", "man", "woman", "women", "for", "him", "her",
  "pour", "homme", "femme", "unisex", "spray", "sprej", "natural", "vapo", "vaporisateur", "ml",
  "new", "original", "u", "i", "de", "o",
  // Czech gender adjectives (Heureka.cz titles always append one) — confirmed
  // live: without these, "dámská"/"pánská" survives normalizeText's
  // diacritic-stripping as a stray "damska"/"panska" token and downgrades an
  // otherwise-exact match to merely "ambiguous".
  "damska", "damsky", "panska", "pansky",
]);

export function canonBrand(s: string): string {
  const n = normalizeText(s);
  return BRAND_ALIASES[n] ?? n;
}

function extractConc(s: string): string | null {
  const n = ` ${normalizeText(s)} `;
  for (const [label, patterns] of CONC_PATTERNS) {
    for (const p of patterns) {
      if (n.includes(` ${p} `)) return label;
    }
  }
  return null;
}

// A tester, a refill cartridge, and a sample vial are all cheaper,
// different products from a standard bottle even when brand/model/ml all
// happen to line up — so a listing carrying one of these markers must never
// silently match a catalog product that doesn't carry the same one.
const VARIANT_MARKERS = ["tester", "napln", "vzorek"];

// Greek "Σετ" (set/bundle — several items for one price) has no Latin
// script at all, so normalizeText's [^a-z0-9] filter erases it completely
// rather than leaving a strippable-but-detectable token the way "tester"
// survives — confirmed live on a Skroutz.gr listing titled "... Σετ ...
// 2τμχ" ("... Set ... 2pcs"), which would otherwise normalize down to
// looking like a plain single-bottle listing. Checked against the raw
// title before normalization can erase it.
const RAW_VARIANT_MARKERS = ["σετ", "set"];

function variantTag(title: string): string | null {
  // Space-bounded, not a bare substring check — "set" as a loose substring
  // would misfire on ordinary words like "Sunset" or "Asset".
  const padded = ` ${title.toLowerCase()} `;
  const raw = RAW_VARIANT_MARKERS.find((marker) => padded.includes(` ${marker} `));
  if (raw) return raw;
  const n = normalizeText(title);
  return VARIANT_MARKERS.find((marker) => n.includes(marker)) ?? null;
}

// All known phrasings of `brand`'s canonical brand — a competitor's title
// might spell it as "Giorgio Armani" while our own vendor field just says
// "Armani"; both need stripping, not just the one we were given. Confirmed
// live: a Giorgio Armani-branded jeftinije.hr listing left "giorgio" behind
// as an orphan token and missed an otherwise-exact match. Longest first, so
// "giorgio armani" is removed as a whole before the bare "armani" pass would
// leave "giorgio" behind.
function brandAliasesFor(brand: string): string[] {
  const canonical = canonBrand(brand);
  const aliases = new Set([normalizeText(brand), canonical]);
  for (const [alias, canon] of Object.entries(BRAND_ALIASES)) {
    if (canon === canonical) aliases.add(alias);
  }
  return [...aliases].sort((a, b) => b.length - a.length);
}

// Title minus brand (and all its known aliases), ml, concentration phrases,
// and generic filler words — what's left has to agree exactly between our
// product and a candidate for them to count as the same fragrance (not a
// flanker of it).
function modelTokens(title: string, brand: string): string[] {
  let n = ` ${normalizeText(title)} `;
  for (const alias of brandAliasesFor(brand)) {
    n = n.split(` ${alias} `).join(" ");
  }
  for (const [, patterns] of CONC_PATTERNS) {
    for (const p of patterns) n = n.split(` ${p} `).join(" ");
  }
  n = n.replace(/\b\d+(?:[.,]\d+)?\s*ml\b/g, " ");
  n = n.replace(/\b\d+(?:[.,]\d+)?\b/g, " ");
  const tokens = n.split(/\s+/).filter((t) => t.length > 1 && !GENERIC.has(t));
  return [...new Set(tokens)].sort();
}

function sameTokens(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export interface MatchCandidate {
  title: string;
  price: number | null;
  url: string;
  // True when this candidate's title had no extractable ml and the pool
  // filter let it through anyway (see matchProduct's pool-filtering
  // comment) — confirmed live on notino.hr that such a candidate's listed
  // price can belong to a DIFFERENT size than the one being matched (a
  // multi-variant product's card shows one price for its whole family, not
  // necessarily the size in our catalog), so the price shown here is not
  // safe to trust without checking the actual product page first.
  sizeUnconfirmed?: boolean;
}

export type MatchResult =
  | { status: "found"; price: number; url: string }
  | { status: "ambiguous"; candidates: MatchCandidate[] }
  | { status: "not_found" };

interface IndexEntry extends JeftinijeListing {
  nTitle: string;
  ml: number | null;
  conc: string | null;
  variant: string | null;
}

export function buildMatchIndex(listings: JeftinijeListing[]): IndexEntry[] {
  return listings
    .filter((l) => l.title)
    .map((l) => ({
      ...l,
      nTitle: normalizeText(l.title),
      ml: (() => {
        const m = extractMl(l.title);
        return m === null ? null : Number(m);
      })(),
      conc: extractConc(l.title),
      variant: variantTag(l.title),
    }));
}

export function matchProduct(
  product: { title: string; vendor: string | null },
  index: IndexEntry[]
): MatchResult {
  const brand = canonBrand(product.vendor ?? "");
  if (!brand) return { status: "not_found" };
  const brandFirstWord = brand.split(" ")[0];

  const mlRaw = extractMl(product.title);
  const ml = mlRaw === null ? null : Number(mlRaw);
  const ourConc = extractConc(product.title);
  const ourModel = modelTokens(product.title, product.vendor ?? "");
  const ourVariant = variantTag(product.title);

  let pool = index.filter((c) => c.nTitle.includes(brandFirstWord));
  if (brand.includes(" ")) pool = pool.filter((c) => c.nTitle.includes(brand));
  // A candidate with no extractable ml isn't necessarily a size mismatch —
  // confirmed live on notino.hr, whose listing cards often omit the size
  // entirely (it only shows once you open the actual product page) — so
  // dropping it here would silently lose real matches instead of at least
  // offering them for a human to confirm. Kept in the pool, but tracked so
  // it can never be promoted to an automatic "found" below.
  if (ml !== null) pool = pool.filter((c) => c.ml === ml || c.ml === null);
  if (pool.length === 0) return { status: "not_found" };

  const exact: IndexEntry[] = [];
  const near: IndexEntry[] = [];

  for (const c of pool) {
    if (c.variant !== ourVariant) continue;
    if (ourConc && c.conc && ourConc !== c.conc) {
      // bare PARFUM vs EXTRAIT is ambiguous, everything else is a hard no
      const pair = new Set([ourConc, c.conc]);
      if (!(pair.has("PARFUM") && pair.has("EXTRAIT"))) continue;
    }
    const mlUnconfirmed = ml !== null && c.ml === null;
    const cModel = modelTokens(c.title, product.vendor ?? "");
    if (sameTokens(cModel, ourModel)) {
      if (mlUnconfirmed) near.push(c); // model agrees but size was never confirmed — needs a human look
      else if (ourConc && c.conc && ourConc === c.conc) exact.push(c);
      else if (!ourConc && !c.conc) exact.push(c);
      else near.push(c); // model matches, one side missing concentration
    } else {
      const a = new Set(cModel);
      const b = new Set(ourModel);
      const subset = [...a].every((t) => b.has(t)) || [...b].every((t) => a.has(t));
      if (a.size > 0 && b.size > 0 && subset && Math.abs(a.size - b.size) <= 1) {
        near.push(c); // possible flanker — one token off, needs a human look
      }
    }
  }

  if (exact.length > 0) {
    const priced = exact.filter((c) => c.priceEur !== null);
    if (priced.length > 0) {
      const best = priced.reduce((min, c) => (c.priceEur! < min.priceEur! ? c : min));
      return { status: "found", price: best.priceEur!, url: best.url };
    }
    // No price on the exact match(es) — fold in any near candidates too
    // (e.g. the EXTRAIT sibling of a PARFUM exact match) so the admin has
    // real alternatives to pick between, not just the one unpriced listing.
    return { status: "ambiguous", candidates: [...exact, ...near].slice(0, 5).map((c) => toCandidate(c, ml)) };
  }
  if (near.length > 0) {
    return { status: "ambiguous", candidates: near.slice(0, 5).map((c) => toCandidate(c, ml)) };
  }
  return { status: "not_found" };
}

function toCandidate(c: IndexEntry, ourMl: number | null): MatchCandidate {
  return { title: c.title, price: c.priceEur, url: c.url, sizeUnconfirmed: ourMl !== null && c.ml === null };
}
