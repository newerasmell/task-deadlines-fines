import type { Product } from "@prisma/client";
import { getRatesTo } from "../lib/exchangeRates";
import { normalizeBarcode, normalizeText } from "../lib/textNormalize";
import { prisma } from "../lib/prisma";

// SKUs are typed by hand into two separate Shopify admins, often by
// different people — stripping everything but letters/digits (spaces,
// dashes, underscores, case) matches "ABC-123" against "abc 123" without
// turning into the fuzzy brand+name text matching the competitor-price
// engine uses, which is deliberately too loose to trust for pushing a real
// price onto a different SKU by mistake.
function normalizeSku(sku: string | null): string | null {
  if (!sku) return null;
  const stripped = sku.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return stripped || null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// A SKU (or barcode) match is still trusted less than an exact key would
// suggest — it's hand-typed data on both sides, and the same SKU getting
// mixed up between two different products is exactly the kind of mistake
// that would otherwise push a wrong price straight to Shopify unnoticed.
// This is a loose "does the name look like the same product" check, not an
// exact match — real listings differ in phrasing ("EDP" vs "Eau de
// Parfum", punctuation) between two stores' admins — so it only flags a
// match whose titles share less than half of the shorter title's words.
function titleTokens(title: string): Set<string> {
  return new Set(normalizeText(title).split(" ").filter((t) => t.length > 1));
}

function titlesLookRelated(a: string, b: string): boolean {
  const tokensA = titleTokens(a);
  const tokensB = titleTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return true; // nothing to compare — don't flag on missing data
  const [shorter, longer] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  let overlap = 0;
  for (const t of shorter) if (longer.has(t)) overlap++;
  return overlap / shorter.size >= 0.5;
}

export interface CrossStoreRow {
  sourceProductId: string;
  targetProductId: string;
  matchedBy: "sku" | "barcode";
  title: string;
  sourceTitle: string;
  // True when the source and target products' titles don't look like the
  // same product despite the SKU/barcode match — a mixed-up SKU on one
  // side is exactly this shape. Flagged rows are never included in "select
  // all"; a person has to look at the two titles and select the row
  // themselves if it's actually fine.
  titleMismatch: boolean;
  variantTitle: string | null;
  sku: string | null;
  vendor: string | null;
  imageUrl: string | null;
  targetPrice: number;
  targetCompareAtPrice: number | null;
  sourcePrice: number;
  sourceCompareAtPrice: number | null;
  // Source price/compare-at converted into the target store's currency —
  // this is what would actually get published. Equal to the raw source
  // values when both stores share a currency.
  newPrice: number;
  newCompareAtPrice: number | null;
  priceChanged: boolean;
  deltaPct: number | null;
}

export interface CrossStoreDiff {
  rows: CrossStoreRow[];
  // Source products with no SKU/barcode match found among the target
  // store's products — never silently dropped, the caller surfaces a count
  // so a real data gap (typo'd SKU, product simply doesn't exist there
  // yet) doesn't look like "everything's already in sync".
  unmatchedSourceCount: number;
  titleMismatchCount: number;
  sourceCurrency: string;
  targetCurrency: string;
  // True when the two stores' currencies differ and no exchange rate could
  // be fetched — `rows` is empty in that case rather than silently falling
  // back to copying the raw number across currencies.
  conversionUnavailable: boolean;
}

export async function buildCrossStoreDiff(sourceStoreId: string, targetStoreId: string): Promise<CrossStoreDiff> {
  const [sourceStore, targetStore] = await Promise.all([
    prisma.store.findUniqueOrThrow({ where: { id: sourceStoreId } }),
    prisma.store.findUniqueOrThrow({ where: { id: targetStoreId } }),
  ]);
  const [sourceProducts, targetProducts] = await Promise.all([
    prisma.product.findMany({ where: { storeId: sourceStoreId } }),
    prisma.product.findMany({ where: { storeId: targetStoreId } }),
  ]);

  const targetBySku = new Map<string, Product>();
  const targetByBarcode = new Map<string, Product>();
  for (const p of targetProducts) {
    const sku = normalizeSku(p.sku);
    if (sku && !targetBySku.has(sku)) targetBySku.set(sku, p);
    if (p.barcode) {
      const bc = normalizeBarcode(p.barcode);
      if (bc && !targetByBarcode.has(bc)) targetByBarcode.set(bc, p);
    }
  }

  const currenciesDiffer = sourceStore.currency !== targetStore.currency;
  let rate = 1;
  if (currenciesDiffer) {
    const fetched = (await getRatesTo([sourceStore.currency], targetStore.currency)).get(sourceStore.currency);
    if (fetched == null) {
      return {
        rows: [],
        unmatchedSourceCount: 0,
        titleMismatchCount: 0,
        sourceCurrency: sourceStore.currency,
        targetCurrency: targetStore.currency,
        conversionUnavailable: true,
      };
    }
    rate = fetched;
  }

  const rows: CrossStoreRow[] = [];
  let unmatchedSourceCount = 0;

  for (const sp of sourceProducts) {
    const sku = normalizeSku(sp.sku);
    let matched: Product | undefined;
    let matchedBy: "sku" | "barcode" | undefined;
    if (sku && targetBySku.has(sku)) {
      matched = targetBySku.get(sku);
      matchedBy = "sku";
    } else if (sp.barcode) {
      const bc = normalizeBarcode(sp.barcode);
      if (bc && targetByBarcode.has(bc)) {
        matched = targetByBarcode.get(bc);
        matchedBy = "barcode";
      }
    }
    if (!matched || !matchedBy) {
      unmatchedSourceCount++;
      continue;
    }

    const newPrice = round2(sp.price * rate);
    const newCompareAtPrice = sp.compareAtPrice != null ? round2(sp.compareAtPrice * rate) : null;
    const priceChanged = newPrice !== matched.price || newCompareAtPrice !== matched.compareAtPrice;
    const deltaPct = matched.price > 0 ? ((newPrice - matched.price) / matched.price) * 100 : null;
    const titleMismatch = !titlesLookRelated(sp.title, matched.title);

    rows.push({
      sourceProductId: sp.id,
      targetProductId: matched.id,
      matchedBy,
      title: matched.title,
      sourceTitle: sp.title,
      titleMismatch,
      variantTitle: matched.variantTitle,
      sku: matched.sku,
      vendor: matched.vendor,
      imageUrl: matched.imageUrl,
      targetPrice: matched.price,
      targetCompareAtPrice: matched.compareAtPrice,
      sourcePrice: sp.price,
      sourceCompareAtPrice: sp.compareAtPrice,
      newPrice,
      newCompareAtPrice,
      priceChanged,
      deltaPct,
    });
  }

  return {
    rows,
    unmatchedSourceCount,
    titleMismatchCount: rows.filter((r) => r.titleMismatch).length,
    sourceCurrency: sourceStore.currency,
    targetCurrency: targetStore.currency,
    conversionUnavailable: false,
  };
}
