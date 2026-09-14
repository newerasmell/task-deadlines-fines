import type { Product, Store } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { shopifyGraphQL } from "./shopifyClient";

const MAX_VARIANTS_PER_CALL = 100;

export interface PublishRequestItem {
  productId: string; // our local Product row id (one per Shopify variant)
  newPrice: number;
  setCompareAt: boolean; // if true, keep the pre-publish price as compareAtPrice
}

export interface PublishResultItem {
  productId: string;
  variantId: string;
  status: "SUCCESS" | "ERROR";
  errorMessage?: string;
}

const BULK_UPDATE_MUTATION = `
  mutation BulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice }
      userErrors { field message }
    }
  }
`;

interface BulkUpdateResponse {
  productVariantsBulkUpdate: {
    productVariants: { id: string; price: string; compareAtPrice: string | null }[];
    userErrors: { field: string[] | null; message: string }[];
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Publishes a batch of price changes to Shopify, grouping by product (the
 * mutation is per-product) and chunking each group to the 100-variant cap.
 * Every variant gets its own publish_log row regardless of which call it
 * rode in on, and its local cached price/compareAtPrice is updated on
 * success so the pricing table reflects the new price without a re-sync.
 */
export async function publishPrices(
  store: Store,
  items: PublishRequestItem[],
  source: "single" | "bulk"
): Promise<PublishResultItem[]> {
  const products = await prisma.product.findMany({
    where: { id: { in: items.map((i) => i.productId) }, storeId: store.id },
  });
  const byId = new Map<string, Product>(products.map((p) => [p.id, p]));

  const byShopifyProduct = new Map<string, { local: Product; item: PublishRequestItem }[]>();
  for (const item of items) {
    const local = byId.get(item.productId);
    if (!local) continue; // silently skip — caller-side race (e.g. row deleted mid-selection)
    const group = byShopifyProduct.get(local.shopifyProductId) ?? [];
    group.push({ local, item });
    byShopifyProduct.set(local.shopifyProductId, group);
  }

  const results: PublishResultItem[] = [];

  for (const [shopifyProductId, group] of byShopifyProduct) {
    for (const batch of chunk(group, MAX_VARIANTS_PER_CALL)) {
      const variantsInput = batch.map(({ local, item }) => {
        const input: Record<string, unknown> = {
          id: local.shopifyVariantId,
          price: item.newPrice.toFixed(2),
        };
        if (item.setCompareAt) input.compareAtPrice = local.price.toFixed(2);
        return input;
      });

      let response: BulkUpdateResponse | null = null;
      let callError: string | null = null;
      try {
        response = await shopifyGraphQL<BulkUpdateResponse>(store, BULK_UPDATE_MUTATION, {
          productId: shopifyProductId,
          variants: variantsInput,
        });
      } catch (err) {
        callError = err instanceof Error ? err.message : "Unknown error";
      }

      const userErrors = response?.productVariantsBulkUpdate.userErrors ?? [];
      // Shopify doesn't reliably map userErrors back to a single variant
      // index for every failure mode, so a batch with ANY error is treated
      // conservatively as a failure for every variant in it — safer than
      // guessing which ones actually landed.
      const batchFailed = Boolean(callError) || userErrors.length > 0;
      const errorMessage = callError ?? userErrors.map((e) => e.message).join("; ") ?? undefined;

      for (const { local, item } of batch) {
        const status: "SUCCESS" | "ERROR" = batchFailed ? "ERROR" : "SUCCESS";
        await prisma.publishLog.create({
          data: {
            storeId: store.id,
            variantId: local.shopifyVariantId,
            productTitle: local.title,
            oldPrice: local.price,
            newPrice: item.newPrice,
            oldCompareAt: local.compareAtPrice,
            newCompareAt: item.setCompareAt ? local.price : local.compareAtPrice,
            status,
            errorMessage: batchFailed ? errorMessage : null,
            source,
          },
        });

        if (!batchFailed) {
          await prisma.product.update({
            where: { id: local.id },
            data: {
              price: item.newPrice,
              compareAtPrice: item.setCompareAt ? local.price : local.compareAtPrice,
            },
          });
        }

        results.push({
          productId: local.id,
          variantId: local.shopifyVariantId,
          status,
          errorMessage: batchFailed ? errorMessage : undefined,
        });
      }
    }
  }

  return results;
}
