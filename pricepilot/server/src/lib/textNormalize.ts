// Shared normalization used on both sides of a match: our own catalog text
// and whatever a competitor source calls the same product.

const DIACRITICS = /[̀-ͯ]/g; // combining marks left behind by NFD normalization

export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeBarcode(input: string): string {
  return input.replace(/\D/g, "");
}

const ML_PATTERN = /(\d+(?:[.,]\d+)?)\s*ml\b/i;

export function extractMl(input: string): string | null {
  const match = input.match(ML_PATTERN);
  if (!match) return null;
  const normalized = match[1].replace(",", ".");
  const num = Number(normalized);
  if (Number.isNaN(num)) return null;
  return String(num); // "50.0" -> "50", "50.5" -> "50.5"
}

/**
 * The fallback match key when no barcode is available on either side:
 * normalized brand+name text, with the ml token pulled out into its own
 * segment so two products only key-equal when their ml also matches
 * exactly (the brief's explicit requirement), not just a fuzzy text match.
 */
export function buildFallbackMatchKey(brand: string | null | undefined, name: string): string {
  const combined = `${brand ?? ""} ${name}`;
  const ml = extractMl(combined);
  const textOnly = normalizeText(combined.replace(ML_PATTERN, " "));
  return `${textOnly}|ml:${ml ?? "none"}`;
}
