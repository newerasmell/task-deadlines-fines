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

export function compareFromPrice(price: number | null, discountPct: number): number | null {
  const discountFrac = discountPct / 100;
  if (price === null || discountFrac >= 1 || discountFrac <= 0) return null;
  const raw = price / (1 - discountFrac);
  return round2(Math.round(raw) - 0.1);
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
