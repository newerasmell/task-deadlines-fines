// EUR is the team's fixed reference currency — every sum shown for a store
// whose own currency isn't EUR (or a competitor price in a third currency)
// gets a small "≈ X EUR" alongside it. `eurRate` converts ONE UNIT of the
// value's own currency into EUR; null means "already EUR" or "rate not
// available", either way nothing extra is shown. Shared across every page
// that displays a store-currency amount (Pricing table, Sales, Publish Log).

export function fmtMoney(v: number | null, currency: string): string {
  if (v == null) return "—";
  return `${v.toFixed(2)} ${currency}`;
}

// A group's variants very often share the same value (the same physical
// product, just different sizes) — collapsing to one value instead of a
// range whenever every row actually agrees.
export function summarizeNumbers(values: (number | null)[]): { allSame: boolean; min: number | null; max: number | null } {
  const nonNull = values.filter((v): v is number => v != null);
  if (nonNull.length === 0) return { allSame: true, min: null, max: null };
  const min = Math.min(...nonNull);
  const max = Math.max(...nonNull);
  return { allSame: min === max && nonNull.length === values.length, min, max };
}

export function eurEquivalent(value: number, currency: string, eurRate: number | null): number | null {
  return currency !== "EUR" && eurRate != null ? value * eurRate : null;
}

// For amounts embedded in a flowing text note (a "·"-separated summary line,
// a translated sentence) rather than their own line — the EUR equivalent
// stays inline as "(≈ X EUR)" instead of Money/MoneyRange's own block line.
export function fmtMoneyEurInline(value: number | null, currency: string, eurRate: number | null): string {
  if (value == null) return "—";
  const eur = eurEquivalent(value, currency, eurRate);
  return eur != null ? `${fmtMoney(value, currency)} (≈ ${fmtMoney(eur, "EUR")})` : fmtMoney(value, currency);
}

// The EUR line is a <span style="display:block"> (via the .money-eur-equiv
// CSS class) rather than a <div> so it nests validly wherever Money/
// MoneyRange get used — inside a <span>, an <a>, or a <td> alike.
export function EurNote({ text }: { text: string }) {
  return <span className="small muted money-eur-equiv">≈ {text}</span>;
}

export function Money({ value, currency, eurRate }: { value: number | null; currency: string; eurRate: number | null }) {
  if (value == null) return <>—</>;
  const eur = eurEquivalent(value, currency, eurRate);
  return (
    <>
      {eur != null && <EurNote text={fmtMoney(eur, "EUR")} />}
      {fmtMoney(value, currency)}
    </>
  );
}

export function MoneyRange({ values, currency, eurRate }: { values: (number | null)[]; currency: string; eurRate: number | null }) {
  const { allSame, min, max } = summarizeNumbers(values);
  if (min == null) return <>—</>;
  const eurMin = eurEquivalent(min, currency, eurRate);
  const eurMax = max != null ? eurEquivalent(max, currency, eurRate) : null;
  return (
    <>
      {eurMin != null && (
        <EurNote text={allSame || eurMax == null ? fmtMoney(eurMin, "EUR") : `${fmtMoney(eurMin, "EUR")} – ${fmtMoney(eurMax, "EUR")}`} />
      )}
      {allSame ? fmtMoney(min, currency) : `${fmtMoney(min, currency)} – ${fmtMoney(max, currency)}`}
    </>
  );
}
