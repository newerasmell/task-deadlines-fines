import type { Store } from "@prisma/client";
import { salesPeriodStart } from "../lib/salesPeriod";
import { prisma } from "../lib/prisma";
import { ShopifyApiError, shopifyGraphQL } from "./shopifyClient";

const ORDERS_BULK_QUERY = (createdAtIso: string) => `
  {
    orders(query: "created_at:>='${createdAtIso}'") {
      edges {
        node {
          id
          cancelledAt
          lineItems {
            edges {
              node {
                quantity
                variant { id }
                discountedTotalSet { shopMoney { amount } }
              }
            }
          }
        }
      }
    }
  }
`;

const BULK_RUN_MUTATION = `
  mutation RunBulk($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

const CURRENT_BULK_QUERY = `
  query { currentBulkOperation { id status errorCode url objectCount } }
`;

interface BulkOperationStatus {
  id: string;
  status: string;
  errorCode: string | null;
  url: string | null;
  objectCount: string | null;
}

async function pollBulkOperation(store: Store, timeoutMs = 5 * 60 * 1000): Promise<BulkOperationStatus> {
  const start = Date.now();
  for (;;) {
    const data = await shopifyGraphQL<{ currentBulkOperation: BulkOperationStatus | null }>(store, CURRENT_BULK_QUERY);
    const op = data.currentBulkOperation;
    if (!op) throw new ShopifyApiError("No bulk operation is running");
    if (op.status === "COMPLETED") return op;
    if (op.status === "FAILED" || op.status === "CANCELED") {
      throw new ShopifyApiError(`Bulk operation ${op.status.toLowerCase()}: ${op.errorCode ?? "unknown error"}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new ShopifyApiError("Bulk operation timed out");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

interface VariantAgg {
  unitsSold: number;
  revenue: number;
}

// Orders' line items come back JSONL-flattened the same way products/
// variants do (see catalogSync.ts) — one line per Order, one per LineItem
// with __parentId pointing back to its order. A cancelled order's line
// items are skipped entirely: they were never actually fulfilled sales,
// just an order record that didn't go through. Partial refunds/returns
// aren't netted out here — a known simplification for v1, same granularity
// the "units sold" figure needs for a first pass at category performance.
async function downloadAndAggregate(url: string): Promise<Map<string, VariantAgg>> {
  const res = await fetch(url);
  if (!res.ok) throw new ShopifyApiError(`Failed to download bulk operation result: ${res.status}`);
  const text = await res.text();

  const cancelledOrders = new Set<string>();
  const lineItems: { parentId: string; variantId: string | null; quantity: number; amount: number }[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const node = JSON.parse(line) as Record<string, unknown> & { id: string; __parentId?: string };

    if (!node.__parentId) {
      if (node.cancelledAt) cancelledOrders.add(node.id);
      continue;
    }
    const variant = node.variant as { id: string } | null;
    const amountStr = (node.discountedTotalSet as { shopMoney: { amount: string } } | null)?.shopMoney?.amount;
    lineItems.push({
      parentId: node.__parentId,
      variantId: variant?.id ?? null,
      quantity: (node.quantity as number) ?? 0,
      amount: amountStr ? Number(amountStr) : 0,
    });
  }

  const byVariant = new Map<string, VariantAgg>();
  for (const item of lineItems) {
    if (!item.variantId || cancelledOrders.has(item.parentId)) continue;
    const agg = byVariant.get(item.variantId) ?? { unitsSold: 0, revenue: 0 };
    agg.unitsSold += item.quantity;
    agg.revenue += item.amount;
    byVariant.set(item.variantId, agg);
  }
  return byVariant;
}

export async function syncOrders(storeId: string): Promise<{ variantsWithSales: number }> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  if (!store.salesAnalyticsEnabled) return { variantsWithSales: 0 };

  const periodEnd = new Date();
  const periodStart = salesPeriodStart(periodEnd);

  const run = await shopifyGraphQL<{
    bulkOperationRunQuery: { bulkOperation: { id: string; status: string } | null; userErrors: { field: string[]; message: string }[] };
  }>(store, BULK_RUN_MUTATION, { query: ORDERS_BULK_QUERY(periodStart.toISOString()) });

  if (run.bulkOperationRunQuery.userErrors.length > 0) {
    throw new ShopifyApiError(run.bulkOperationRunQuery.userErrors.map((e) => e.message).join("; "));
  }

  const completed = await pollBulkOperation(store);
  const byVariant = completed.url ? await downloadAndAggregate(completed.url) : new Map<string, VariantAgg>();

  // Every one of the store's products gets a fresh row this run — including
  // a 0/0 row for a variant with no sales in the window — so a product that
  // sold well last period but nothing this period doesn't keep showing its
  // stale old numbers.
  const products = await prisma.product.findMany({ where: { storeId }, select: { id: true, shopifyVariantId: true } });
  for (const product of products) {
    const agg = byVariant.get(product.shopifyVariantId) ?? { unitsSold: 0, revenue: 0 };
    await prisma.productSales.upsert({
      where: { productId: product.id },
      create: { productId: product.id, unitsSold6m: agg.unitsSold, revenue6m: agg.revenue, periodStart, periodEnd },
      update: { unitsSold6m: agg.unitsSold, revenue6m: agg.revenue, periodStart, periodEnd, syncedAt: new Date() },
    });
  }

  return { variantsWithSales: byVariant.size };
}
