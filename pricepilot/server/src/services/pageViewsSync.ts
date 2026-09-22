import { prisma } from "../lib/prisma";
import { salesPeriodStart } from "../lib/salesPeriod";
import { env } from "../lib/env";
import { fetchProductPageViews } from "./ga4Client";

// No-ops gracefully rather than throwing — a store can have
// salesAnalyticsEnabled on (for the units-sold/avg-price columns from
// ordersSync.ts) without GA4 configured at all, either because the shared
// Google OAuth app (env.google*) hasn't been set up yet or because this
// particular store hasn't picked a ga4PropertyId. Either way the "Продажби"
// tab just shows "—" for page views/conv rate until both are in place.
export async function syncPageViews(storeId: string): Promise<{ productsUpdated: number }> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  if (!store.salesAnalyticsEnabled || !store.ga4PropertyId) return { productsUpdated: 0 };
  if (!env.googleClientId || !env.googleClientSecret || !env.googleRefreshToken) return { productsUpdated: 0 };

  const periodEnd = new Date();
  const periodStart = salesPeriodStart(periodEnd);
  const byHandle = await fetchProductPageViews(store.ga4PropertyId, periodStart, periodEnd);

  const products = await prisma.product.findMany({ where: { storeId }, select: { id: true, handle: true } });
  let productsUpdated = 0;
  for (const product of products) {
    if (!product.handle) continue;
    const pageViews6m = byHandle.get(product.handle) ?? 0;
    await prisma.productPageViews.upsert({
      where: { productId: product.id },
      create: { productId: product.id, pageViews6m, periodStart, periodEnd },
      update: { pageViews6m, periodStart, periodEnd, syncedAt: new Date() },
    });
    productsUpdated++;
  }
  return { productsUpdated };
}
