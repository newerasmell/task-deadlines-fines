import type { CodFormulaConfig } from "@prisma/client";

export interface CodScenario {
  key: string;
  label: string;
  A: number; // ad spend per registered order, currency
  d: number; // delivery success rate, 0-1
  S: number; // one-way shipping/packaging, currency
}

export interface CodBracket {
  upper: number | null; // null = unbounded
  rate: number; // 0-1
}

export function parseScenarios(config: CodFormulaConfig): CodScenario[] {
  const raw = JSON.parse(config.scenariosJson) as { key: string; label: string; A: number; d: number; S: number }[];
  return raw.map((s) => ({ ...s, d: s.d / 100 }));
}

export function parseBrackets(config: CodFormulaConfig): CodBracket[] {
  const raw = JSON.parse(config.bracketsJson) as { upper: number | null; rate: number }[];
  return raw.map((b) => ({ upper: b.upper, rate: b.rate / 100 }));
}

export function pickScenario(scenarios: CodScenario[], key: string): CodScenario {
  return scenarios.find((s) => s.key === key) ?? scenarios[0];
}

/**
 * Same k-multiplier formula as the standalone COD calculator: in "cost" mode
 * it's a flat markup off cogs_pct; in "target"/"breakeven" mode it's derived
 * from the full monthly P&L so that, at the chosen scenario and N, the
 * store's average cost `c` would land on the target net profit (0 for
 * break-even). One k is computed store-wide (off the average known cost)
 * and then applied to every product's own cost — see priceFromCost.
 */
export function computeK(
  config: CodFormulaConfig,
  avgCost: number,
  scenario: CodScenario
): { k: number | null; reason: string | null } {
  if (config.mode === "cost") {
    const cogs = config.cogsPct / 100;
    if (cogs <= 0 || cogs >= 1) return { k: null, reason: "cogs_pct трябва да е между 0 и 100%." };
    return { k: 1 / cogs, reason: null };
  }

  const { d, A, S } = scenario;
  const n = config.nItems;
  const r = config.rMult;
  const L = config.lLoss / 100;
  const F = config.fCost;
  const N = config.pricingN;
  const f = config.fRate / 100;
  const m = config.mode === "breakeven" ? 0 : config.mRate / 100;

  if (avgCost <= 0) return { k: null, reason: "Няма известна себестойност на нито един продукт — качи costs.csv или задай ръчно." };
  if (d <= 0) return { k: null, reason: "d (delivery success rate) трябва да е > 0." };
  if (N <= 0) return { k: null, reason: "N за формулата трябва да е > 0." };

  const denom = d * n * (1 - f - m) * avgCost;
  if (denom <= 0) return { k: null, reason: "f + m ≥ 100% — формулата няма решение. Намали агентската ставка или целевата печалба." };

  const numerator = n * avgCost * (d + L * (1 - d)) + A + S * (d + r * (1 - d)) + F / N;
  return { k: numerator / denom, reason: null };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function priceFromCost(cost: number, k: number | null, step: number): number | null {
  if (k === null || !isFinite(k) || step <= 0 || cost <= 0) return null;
  const raw = cost * k;
  const rounded = Math.ceil(raw / step) * step;
  const price = round2(rounded - 0.1);
  return price > 0 ? price : null;
}

// "Charm price" rounding (round to the nearest whole number, then -0.10,
// e.g. 101.9 not 101.92) — used once, after averaging a product's raw base
// price across its categories, rather than per-category and risking float
// drift on the average.
export function roundCharmPrice(raw: number): number {
  return round2(Math.round(raw) - 0.1);
}

// Stable, deterministic [0, 1) value derived from a string id — deliberately
// NOT Math.random(): the same product must always land in the same spot, or
// "suggested" would flicker on every page reload and undermine trust in
// what gets published. Distribution doesn't need to be cryptographic-grade,
// just spread a handful of ids across the range instead of clustering.
function stableFraction(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (hash % 10000) / 10000;
}

// Every product priced off a shared CATEGORY-AVERAGE cost (no SKU/EAN cost
// of its own) computes the exact same recommended price — confirmed live: a
// whole "Шапки" category costed off one shared 25€ average all suggested
// exactly 79.90€. Spreads them across [price, price×1.15] instead, anchored
// per-product so the same item always lands in the same place on reload —
// a brand-coefficient-style placement doesn't work here since two products
// from the same brand would still collide on the same number. Never
// applied to a product with its own real SKU cost, which already varies
// naturally on its own.
const CATEGORY_PRICE_VARIATION_PCT = 15;

export function varyPriceForSharedCost(price: number, productId: string): number {
  const fraction = stableFraction(productId);
  return roundCharmPrice(price * (1 + fraction * (CATEGORY_PRICE_VARIATION_PCT / 100)));
}

// Where a product's suggested base/compare-at price falls inside its
// category's manually-set [min, max] envelope — placed by how its brand's
// coefficient (1-10, Марки tab) ranks against the coefficients of every
// OTHER brand actually selling in that same category, not against a global
// scale. A category stocking only mid-tier brands should still be able to
// span its own full min-max range; anchoring to a store-wide coefficient
// scale would compress it toward one end for no reason. `lo`/`hi` are the
// min/max coefficient among that category's own brands; a category with
// only one distinct coefficient (often just one brand) has no ranking
// information at all, so it lands exactly in the middle of the range.
export function rawBasePriceFromCoefficient(min: number, max: number, coefficient: number, lo: number, hi: number): number {
  const normalized = hi > lo ? (coefficient - lo) / (hi - lo) : 0.5;
  return min + normalized * (max - min);
}

export interface MarkdownInput {
  isInMarkdownCollection: boolean;
  activatedAt: Date | null;
  currentPrice: number;
  formulaRecommendedPrice: number | null; // the floor — never suggest below this
  afterDays: number;
  ceilingPct: number; // 10-15, typically
  now: Date;
}

export interface MarkdownResult {
  // True only when a price change is actually needed right now (past the
  // wait window AND currently priced above the ceiling) — a new arrival
  // that's simply not old enough yet, or one already inside its allowed
  // band, is not "eligible": there's nothing for anyone to act on.
  eligible: boolean;
  daysSinceActive: number | null;
  ceiling: number | null;
  suggestedPrice: number | null;
}

/**
 * New-arrival markdown: a product tagged into the store's markdown
 * collection starts a countdown the moment it's first observed ACTIVE in
 * Shopify (Product.activatedAt, stamped once by catalogSync.ts). Once
 * `afterDays` have passed, if its current price still sits more than
 * `ceilingPct` above the formula's own recommended price, it's flagged and
 * the suggested new price is exactly that ceiling — never below the
 * formula price (the ceiling is defined as a markup ON TOP of it, so it can
 * never land under it), and never more than `ceilingPct` above it either.
 */
export function computeMarkdown(input: MarkdownInput): MarkdownResult {
  const { isInMarkdownCollection, activatedAt, currentPrice, formulaRecommendedPrice, afterDays, ceilingPct, now } = input;

  if (!isInMarkdownCollection || !activatedAt || formulaRecommendedPrice == null) {
    return { eligible: false, daysSinceActive: null, ceiling: null, suggestedPrice: null };
  }

  const daysSinceActive = Math.floor((now.getTime() - activatedAt.getTime()) / (1000 * 60 * 60 * 24));
  if (daysSinceActive < afterDays) {
    return { eligible: false, daysSinceActive, ceiling: null, suggestedPrice: null };
  }

  const ceiling = roundCharmPrice(formulaRecommendedPrice * (1 + ceilingPct / 100));
  if (currentPrice <= ceiling) {
    return { eligible: false, daysSinceActive, ceiling, suggestedPrice: null }; // already inside the allowed band
  }

  return { eligible: true, daysSinceActive, ceiling, suggestedPrice: ceiling };
}

const SALE_DISCOUNT_MIN_PCT = 30;
const SALE_DISCOUNT_MAX_PCT = 35;

// Where a "c_sale"-tagged item's extra markdown lands within [30,35]% off —
// same direction as rawBasePriceFromCoefficient: a higher coefficient
// (premium brand, presumably fatter margin) can absorb the deeper end of
// the cut; a budget brand's already-thin margin gets the gentler end. Uses
// the coefficient's own raw 1-10 scale rather than a category-relative
// ranking (unlike base-price placement) — a SALE tag should still produce
// a discount even for a product whose category has no min/max base-price
// range configured. A brand that's never been ranked (no coefficient set)
// falls back to the midpoint rather than blocking the discount outright.
export function saleDiscountPctForCoefficient(coefficient: number | null): number {
  if (coefficient == null) return (SALE_DISCOUNT_MIN_PCT + SALE_DISCOUNT_MAX_PCT) / 2;
  const normalized = Math.min(1, Math.max(0, (coefficient - 1) / 9));
  return SALE_DISCOUNT_MIN_PCT + normalized * (SALE_DISCOUNT_MAX_PCT - SALE_DISCOUNT_MIN_PCT);
}

export interface SaleDiscountResult {
  applied: boolean;
  discountPct: number | null;
  preSalePrice: number | null;
  price: number | null;
}

// Cuts further off whatever the product's CURRENT suggested price already
// is — its normal formula price, or its markdown ceiling if that's already
// kicked in — never off the original base/compare-at price (that stays put
// as the crossed-out price). `costFloor` is a hard stop at the product's
// own acquisition cost: a clearance sale can price well below the formula's
// normal margin-protecting floor, but never below what the item actually
// cost to acquire — that would turn "moving old stock" into a real loss.
export function applySaleDiscount(basePrice: number | null, coefficient: number | null, costFloor: number | null): SaleDiscountResult {
  if (basePrice == null) return { applied: false, discountPct: null, preSalePrice: null, price: null };
  const discountPct = saleDiscountPctForCoefficient(coefficient);
  const raw = basePrice * (1 - discountPct / 100);
  const floored = costFloor != null ? Math.max(raw, costFloor) : raw;
  return { applied: true, discountPct, preSalePrice: basePrice, price: roundCharmPrice(floored) };
}

export type CodRowFlag = "below-floor" | "competitive" | "above-market" | "no-data";

// Same competitive-band idea as the undercut engine (suggestionEngine.ts's
// COMPETITIVE_BAND_PCT): current price within this band of the recommended
// minimum counts as "on target" rather than flagging it either direction.
const BAND_PCT = 2;

export function flagForPrice(ourPrice: number, recommended: number | null): CodRowFlag {
  if (recommended === null) return "no-data";
  if (ourPrice < recommended * (1 - BAND_PCT / 100)) return "below-floor";
  if (ourPrice > recommended * (1 + BAND_PCT / 100)) return "above-market";
  return "competitive";
}
