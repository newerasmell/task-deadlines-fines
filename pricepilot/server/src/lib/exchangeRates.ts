import { politeGet } from "./httpClient";

// Reference-only conversion for display in the pricing table (e.g. "≈ 42.10
// EUR" next to a competitor price quoted in USD) — never used in the actual
// undercut/match suggestion math, which stays same-currency throughout.
// Frankfurter (ECB daily rates) needs no API key and has no meaningful rate
// limit for this pilot's traffic.

interface RateCache {
  rates: Record<string, number>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cacheByBase = new Map<string, RateCache>();

async function fetchRates(base: string): Promise<Record<string, number> | null> {
  try {
    const body = await politeGet(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}`, 8000);
    const parsed = JSON.parse(body) as { rates?: Record<string, number> };
    return parsed.rates ?? null;
  } catch {
    return null;
  }
}

async function getRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  const cached = cacheByBase.get(from);
  const rates = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS ? cached.rates : await fetchRates(from);
  if (!rates) return null;
  if (!cached || cached.rates !== rates) cacheByBase.set(from, { rates, fetchedAt: Date.now() });
  return rates[to] ?? null;
}

/** Best-effort — returns null (never throws) when the pair or the rate service itself isn't available; callers treat that as "no reference to show". */
export async function convertAmount(amount: number, from: string, to: string): Promise<number | null> {
  const rate = await getRate(from, to);
  return rate == null ? null : amount * rate;
}

/** Resolves a rate-to-`to` for each distinct currency in `currencies`, skipping `to` itself. Used to convert a whole batch of cells with one rate lookup per currency instead of one per cell. */
export async function getRatesTo(currencies: string[], to: string): Promise<Map<string, number>> {
  const distinct = Array.from(new Set(currencies.filter((c) => c !== to)));
  const entries = await Promise.all(distinct.map(async (cur) => [cur, await getRate(cur, to)] as const));
  const map = new Map<string, number>();
  for (const [cur, rate] of entries) if (rate != null) map.set(cur, rate);
  return map;
}
