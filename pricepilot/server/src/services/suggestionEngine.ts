export type RowFlag = "above-market" | "competitive" | "below-market" | "below-floor" | "no-data";

export interface PricingRule {
  strategy: "undercut_min" | "match_min" | "undercut_avg";
  undercutPct: number;
  priceEnding: string | null;
  minMarginPct: number;
}

export interface SuggestionInput {
  ourPrice: number;
  competitorPrices: number[]; // from active, matched sources only
  cost: number | null;
  rule: PricingRule;
  noCostFloorPct: number;
}

export interface SuggestionResult {
  minComp: number | null;
  avgComp: number | null;
  rawTarget: number | null;
  floor: number;
  suggested: number | null;
  flag: RowFlag;
}

// How far above the market's minimum our CURRENT price has to sit before a
// row is flagged red instead of green — not in the brief's field list as a
// store-level setting, so kept as one easy-to-adjust constant rather than
// unrequested extra config surface.
const COMPETITIVE_BAND_PCT = 2;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Rounds `value` DOWN to the nearest price ending it (e.g. ".99" pulls
 * 47.32 down to 46.99, never up to 47.99) — an ending is a ceiling on the
 * decimal part, not a target to round to the nearest of.
 */
export function applyPriceEnding(value: number, ending: string | null): number {
  if (!ending) return round2(value);
  const frac = parseFloat(ending);
  if (Number.isNaN(frac)) return round2(value);
  const base = Math.floor(value);
  let candidate = base + frac;
  if (candidate > value + 1e-9) candidate -= 1;
  return round2(candidate);
}

export function computeSuggestion(input: SuggestionInput): SuggestionResult {
  const { ourPrice, competitorPrices, cost, rule, noCostFloorPct } = input;
  const floor = round2(cost != null ? cost * (1 + rule.minMarginPct / 100) : ourPrice * noCostFloorPct);

  if (competitorPrices.length === 0) {
    return { minComp: null, avgComp: null, rawTarget: null, floor, suggested: null, flag: "no-data" };
  }

  const minComp = Math.min(...competitorPrices);
  const avgComp = competitorPrices.reduce((a, b) => a + b, 0) / competitorPrices.length;

  const rawTarget =
    rule.strategy === "match_min"
      ? minComp
      : rule.strategy === "undercut_avg"
        ? avgComp * (1 - rule.undercutPct / 100)
        : minComp * (1 - rule.undercutPct / 100); // undercut_min

  const withEnding = applyPriceEnding(rawTarget, rule.priceEnding);

  if (withEnding < floor) {
    return {
      minComp: round2(minComp),
      avgComp: round2(avgComp),
      rawTarget: round2(rawTarget),
      floor,
      suggested: floor,
      flag: "below-floor",
    };
  }

  let flag: RowFlag;
  if (ourPrice > minComp * (1 + COMPETITIVE_BAND_PCT / 100)) flag = "above-market";
  else if (ourPrice < minComp) flag = "below-market";
  else flag = "competitive";

  return {
    minComp: round2(minComp),
    avgComp: round2(avgComp),
    rawTarget: round2(rawTarget),
    floor,
    suggested: withEnding,
    flag,
  };
}
