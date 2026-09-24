import type { Product, PublishLog, Store } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { shopifyGraphQL } from "./shopifyClient";

const MAX_VARIANTS_PER_CALL = 100;

export interface PublishRequestItem {
  productId: string; // our local Product row id (one per Shopify variant)
  newPrice: number;
  setCompareAt: boolean; // if true, keep the pre-publish price as compareAtPrice
  // Explicit compare-at (e.g. the cod_formula engine's computed slashed
  // price) — takes priority over setCompareAt's "old price becomes
  // compare-at" behavior when present.
  newCompareAtPrice?: number | null;
  // True for a row the Pricing table currently shows as markdown-eligible
  // (COD stores only — see codPricingEngine.ts's computeMarkdown) at the
  // moment Publish was clicked — same trust level as newPrice/
  // newCompareAtPrice above, which the frontend already computes from the
  // same row. Triggers store.newArrivalTag's removal below.
  removeNewArrivalTag?: boolean;
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

const TAGS_REMOVE_MUTATION = `
  mutation RemoveTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

interface TagsRemoveResponse {
  tagsRemove: { userErrors: { field: string[] | null; message: string }[] };
}

function hasTag(tagsCsv: string | null, tag: string): boolean {
  if (!tagsCsv) return false;
  return tagsCsv
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .includes(tag.trim().toLowerCase());
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
    let removeTagRequested = false;

    for (const batch of chunk(group, MAX_VARIANTS_PER_CALL)) {
      const variantsInput = batch.map(({ local, item }) => {
        const input: Record<string, unknown> = {
          id: local.shopifyVariantId,
          price: item.newPrice.toFixed(2),
        };
        if (item.newCompareAtPrice != null) input.compareAtPrice = item.newCompareAtPrice.toFixed(2);
        else if (item.setCompareAt) input.compareAtPrice = local.price.toFixed(2);
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
        const newCompareAt = item.newCompareAtPrice != null ? item.newCompareAtPrice : item.setCompareAt ? local.price : local.compareAtPrice;
        await prisma.publishLog.create({
          data: {
            storeId: store.id,
            variantId: local.shopifyVariantId,
            productTitle: local.title,
            oldPrice: local.price,
            newPrice: item.newPrice,
            oldCompareAt: local.compareAtPrice,
            newCompareAt,
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
              compareAtPrice: newCompareAt,
            },
          });
          if (item.removeNewArrivalTag) removeTagRequested = true;
        }

        results.push({
          productId: local.id,
          variantId: local.shopifyVariantId,
          status,
          errorMessage: batchFailed ? errorMessage : undefined,
        });
      }
    }

    // Clears the storefront's own "new arrival" badge tag the moment a
    // markdown-eligible price actually lands on Shopify — never before a
    // successful price publish, and only if the product still carries the
    // tag (skips a pointless call otherwise; also means a product whose
    // price was manually fixed in Shopify itself, bypassing this app,
    // keeps its badge until published here).
    if (removeTagRequested && store.newArrivalTag.trim()) {
      const representative = group[0].local;
      if (hasTag(representative.tags, store.newArrivalTag)) {
        try {
          await shopifyGraphQL<TagsRemoveResponse>(store, TAGS_REMOVE_MUTATION, {
            id: shopifyProductId,
            tags: [store.newArrivalTag],
          });
          const remainingTags = (representative.tags ?? "")
            .split(",")
            .filter((t) => t.trim().toLowerCase() !== store.newArrivalTag.trim().toLowerCase())
            .join(",");
          await prisma.product.updateMany({ where: { storeId: store.id, shopifyProductId }, data: { tags: remainingTags } });
        } catch (err) {
          // A failed tag removal never fails the price publish itself — the
          // price is already live on Shopify by this point regardless, and
          // the next catalog sync will pick the tag's true current state
          // back up anyway.
          console.error(`[publishEngine] failed to remove newArrivalTag for ${shopifyProductId}`, err);
        }
      }
    }
  }

  return results;
}

export interface RevertResultItem {
  logId: string;
  status: "SUCCESS" | "ERROR";
  errorMessage?: string;
}

interface RevertPlan {
  log: PublishLog;
  product: Product;
  priceChanged: boolean;
  compareAtChanged: boolean;
}

/**
 * Reverts a batch of PublishLog entries — per entry, only the field(s) that
 * entry actually changed (price, compareAtPrice, or both; a publish that
 * only moved one of the two leaves the other alone on revert too). Refuses
 * an entry outright rather than guessing if the LIVE value no longer
 * matches what that publish set it to — meaning something newer (a later
 * publish, or a manual Shopify edit) has happened since, and blindly
 * overwriting it with a stale "old" value would silently clobber that
 * newer change instead of undoing the one the admin actually clicked
 * revert on.
 */
export async function revertPublishes(store: Store, logIds: string[]): Promise<RevertResultItem[]> {
  const logs = await prisma.publishLog.findMany({ where: { id: { in: logIds }, storeId: store.id } });
  const results: RevertResultItem[] = [];
  const plans: RevertPlan[] = [];

  for (const log of logs) {
    if (log.status !== "SUCCESS") {
      results.push({ logId: log.id, status: "ERROR", errorMessage: "Само успешни публикации могат да бъдат върнати." });
      continue;
    }
    if (log.revertedAt) {
      results.push({ logId: log.id, status: "ERROR", errorMessage: "Вече е върната." });
      continue;
    }
    const product = await prisma.product.findUnique({
      where: { storeId_shopifyVariantId: { storeId: store.id, shopifyVariantId: log.variantId } },
    });
    if (!product) {
      results.push({ logId: log.id, status: "ERROR", errorMessage: "Продуктът вече не е синхронизиран локално." });
      continue;
    }

    const priceChanged = log.oldPrice !== log.newPrice;
    const compareAtChanged = log.oldCompareAt !== log.newCompareAt;

    if (priceChanged && product.price !== log.newPrice) {
      results.push({
        logId: log.id,
        status: "ERROR",
        errorMessage: `Текущата цена (${product.price}) вече се различава от тази публикация (${log.newPrice}) — вероятно има по-нова промяна. Revert отказан.`,
      });
      continue;
    }
    if (compareAtChanged && product.compareAtPrice !== log.newCompareAt) {
      results.push({
        logId: log.id,
        status: "ERROR",
        errorMessage: `Текущият compare-at вече се различава от тази публикация — вероятно има по-нова промяна. Revert отказан.`,
      });
      continue;
    }

    plans.push({ log, product, priceChanged, compareAtChanged });
  }

  // Nothing to revert on Shopify (both fields already matched old==new for
  // this entry) — never happens in practice, but handled without a Shopify
  // call rather than lumping it in with a batch call meant for other items.
  const noopPlans = plans.filter((p) => !p.priceChanged && !p.compareAtChanged);
  const revertPlans = plans.filter((p) => p.priceChanged || p.compareAtChanged);

  async function finalizeRevert(plan: RevertPlan): Promise<void> {
    const { log, product, priceChanged, compareAtChanged } = plan;
    const revertedPrice = priceChanged ? log.oldPrice : product.price;
    const revertedCompareAt = compareAtChanged ? log.oldCompareAt : product.compareAtPrice;

    await prisma.publishLog.create({
      data: {
        storeId: store.id,
        variantId: product.shopifyVariantId,
        productTitle: product.title,
        oldPrice: product.price,
        newPrice: revertedPrice,
        oldCompareAt: product.compareAtPrice,
        newCompareAt: revertedCompareAt,
        status: "SUCCESS",
        source: "revert",
      },
    });
    await prisma.publishLog.update({ where: { id: log.id }, data: { revertedAt: new Date() } });
    await prisma.product.update({ where: { id: product.id }, data: { price: revertedPrice, compareAtPrice: revertedCompareAt } });
    results.push({ logId: log.id, status: "SUCCESS" });
  }

  for (const plan of noopPlans) await finalizeRevert(plan);

  const byShopifyProduct = new Map<string, RevertPlan[]>();
  for (const plan of revertPlans) {
    const group = byShopifyProduct.get(plan.product.shopifyProductId) ?? [];
    group.push(plan);
    byShopifyProduct.set(plan.product.shopifyProductId, group);
  }

  for (const [shopifyProductId, group] of byShopifyProduct) {
    for (const batch of chunk(group, MAX_VARIANTS_PER_CALL)) {
      const variantsInput = batch.map((p) => {
        const input: Record<string, unknown> = { id: p.product.shopifyVariantId };
        if (p.priceChanged) input.price = p.log.oldPrice.toFixed(2);
        if (p.compareAtChanged) input.compareAtPrice = p.log.oldCompareAt != null ? p.log.oldCompareAt.toFixed(2) : null;
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
      const batchFailed = Boolean(callError) || userErrors.length > 0;
      const errorMessage = callError ?? userErrors.map((e) => e.message).join("; ");

      for (const plan of batch) {
        if (batchFailed) {
          results.push({ logId: plan.log.id, status: "ERROR", errorMessage: errorMessage || "Shopify update failed" });
          continue;
        }
        await finalizeRevert(plan);
      }
    }
  }

  return results;
}
