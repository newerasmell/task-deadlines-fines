import { prisma } from "../lib/prisma";
import { buildFallbackMatchKey, normalizeBarcode } from "../lib/textNormalize";

/** The two match keys a Product can be found under: EAN first, text fallback second. */
export function productMatchKeys(product: { barcode: string | null; vendor: string | null; title: string }): {
  barcodeKey: string | null;
  fallbackKey: string;
} {
  return {
    barcodeKey: product.barcode ? normalizeBarcode(product.barcode) : null,
    fallbackKey: buildFallbackMatchKey(product.vendor, product.title),
  };
}

/**
 * Re-resolves every CompetitorPrice row for a store's sources against the
 * current product catalog: a manual binding always wins; otherwise exact
 * barcode match, then the normalized brand+name+ml fallback. Cheap enough
 * to just re-run in full after every refresh or catalog sync at pilot
 * scale, rather than tracking incremental diffs.
 */
export async function resolveMatchesForStore(storeId: string): Promise<void> {
  const [products, sources] = await Promise.all([
    prisma.product.findMany({ where: { storeId } }),
    prisma.source.findMany({ where: { storeId }, select: { id: true } }),
  ]);
  const sourceIds = sources.map((s) => s.id);
  if (sourceIds.length === 0) return;

  const byBarcode = new Map<string, string>(); // barcodeKey -> productId
  const byFallback = new Map<string, string>(); // fallbackKey -> productId
  for (const product of products) {
    const { barcodeKey, fallbackKey } = productMatchKeys(product);
    if (barcodeKey) byBarcode.set(barcodeKey, product.id);
    if (!byFallback.has(fallbackKey)) byFallback.set(fallbackKey, product.id); // first wins on collision
  }

  const manualMatches = await prisma.manualMatch.findMany({ where: { storeId } });
  const manualByKey = new Map<string, string>(); // `${sourceId}|${matchKey}` -> productId
  for (const m of manualMatches) manualByKey.set(`${m.sourceId}|${m.resolvedMatchKey}`, m.productId);

  const competitorPrices = await prisma.competitorPrice.findMany({ where: { sourceId: { in: sourceIds } } });

  for (const cp of competitorPrices) {
    // matchKey is already normalized when written (see competitorCollection.ts):
    // a pure-digit barcode, or the text|ml: fallback key — never both, so
    // trying the wrong lookup on a given key is just a harmless miss.
    const manual = manualByKey.get(`${cp.sourceId}|${cp.matchKey}`);
    const barcodeMatch = /^\d{6,14}$/.test(cp.matchKey) ? byBarcode.get(cp.matchKey) : undefined;
    const fallbackMatch = byFallback.get(cp.matchKey);
    const resolvedProductId = manual ?? barcodeMatch ?? fallbackMatch ?? null;

    if (resolvedProductId !== cp.productId) {
      await prisma.competitorPrice.update({ where: { id: cp.id }, data: { productId: resolvedProductId } });
    }
  }
}
