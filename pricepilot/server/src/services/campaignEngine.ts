import type { Store } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { publishPrices, revertPublishes, setProductTag, type PublishResultItem, type RevertResultItem } from "./publishEngine";

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface StartCampaignInput {
  name: string;
  campaignType: string; // black_friday | christmas | summer | custom
  discountPct: number;
  // Exactly one is set by the route (zod enforces it) — durationMinutes
  // exists purely so a campaign can be tested end-to-end (apply → wait a
  // few minutes → confirm it auto-reverted) without waiting a full day.
  durationDays?: number;
  durationMinutes?: number;
  // Added to every product below when the campaign starts, removed again
  // once it's fully reverted — required (never ""), so a campaign always
  // has a clear "these products are in this campaign" marker in Shopify.
  tag: string;
  productIds: string[];
  createdById: string | null;
}

export interface StartCampaignResult {
  campaignId: string;
  results: PublishResultItem[];
}

/**
 * Applies a time-boxed extra discount on top of each product's CURRENT
 * live price (never a "base" price field — `product.price` already IS
 * whatever price is live right now, competitor-suggested or otherwise).
 * compareAtPrice keeps the product's EXISTING compare-at when it already
 * has one (a genuinely higher original/reference price shouldn't be
 * clobbered by today's pre-campaign price) and only falls back to the
 * pre-campaign price for a product that had no compare-at at all — either
 * way the storefront keeps showing a real struck-through "was/now" price.
 * Reuses the exact same
 * publishPrices() every other publish path uses — a campaign is just a
 * named, time-boxed group of ordinary publishes (source="campaign",
 * campaignId set on each resulting PublishLog row) — so it inherits the
 * same per-variant batching/chunking and PublishLog bookkeeping for free.
 * The Campaign row is created FIRST (before any Shopify call) so its id
 * exists to stamp onto the publish results; if every item then fails to
 * publish, the campaign is left with zero successful log rows and the
 * scheduler's auto-revert tick simply has nothing to do for it later.
 *
 * Also tags every one of those products with `input.tag` in Shopify (the
 * same campaign/marketing tag used to shortlist them in the first place,
 * by default) — this is what revertCampaign later removes once the
 * campaign ends, so the tag only marks "currently in a running campaign"
 * rather than lingering forever. Tagging is best-effort: a failure here
 * is logged, not thrown, since the price change is the part of this that
 * actually matters.
 */
export async function startCampaign(store: Store, input: StartCampaignInput): Promise<StartCampaignResult> {
  const products = await prisma.product.findMany({
    where: { id: { in: input.productIds }, storeId: store.id },
  });

  const durationMs =
    input.durationMinutes != null ? input.durationMinutes * 60 * 1000 : (input.durationDays ?? 0) * 24 * 60 * 60 * 1000;
  const endsAt = new Date(Date.now() + durationMs);
  const campaign = await prisma.campaign.create({
    data: {
      storeId: store.id,
      name: input.name,
      campaignType: input.campaignType,
      discountPct: input.discountPct,
      tag: input.tag,
      productIds: products.map((p) => p.id).join(","),
      endsAt,
      createdById: input.createdById,
    },
  });

  const items = products.map((p) => ({
    productId: p.id,
    newPrice: round2(p.price * (1 - input.discountPct / 100)),
    setCompareAt: false,
    newCompareAtPrice: p.compareAtPrice ?? p.price,
  }));

  const results = items.length > 0 ? await publishPrices(store, items, "campaign", undefined, campaign.id) : [];

  if (products.length > 0) {
    const tagResults = await setProductTag(store, products.map((p) => p.id), input.tag, "add");
    const tagFailCount = tagResults.filter((r) => r.status === "ERROR").length;
    if (tagFailCount > 0) {
      console.error(`[campaignEngine] failed to tag ${tagFailCount} product(s) for campaign ${campaign.id}`);
    }
  }

  return { campaignId: campaign.id, results };
}

export interface RevertCampaignResult {
  campaignId: string;
  results: RevertResultItem[];
}

/**
 * Reverts whatever's left of a campaign's own publishes — called both by
 * the "Revert now" button and by the scheduler once endsAt passes. Reuses
 * revertPublishes() as-is, including its safety check (refuses an item
 * whose live price has since changed again, e.g. a later manual edit) —
 * an item that gets refused stays un-reverted and visibly flagged in the
 * results rather than silently skipped, so a partially-reverted campaign
 * is still obviously not fully REVERTED. The campaign only flips to
 * REVERTED once every one of its still-active log rows has actually been
 * reverted; otherwise it's left ACTIVE so the next tick (or another manual
 * click) retries the remainder. Only once it's fully REVERTED does the
 * campaign's tag get removed from the products it was applied to
 * (`productIds`, stamped at start — null for a campaign created before
 * this field existed, which just skips the untag step) — same best-effort
 * handling as the tag-add in startCampaign.
 */
export async function revertCampaign(store: Store, campaignId: string): Promise<RevertCampaignResult> {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const logs = await prisma.publishLog.findMany({
    where: { campaignId, storeId: store.id, status: "SUCCESS", revertedAt: null },
  });

  const results = logs.length > 0 ? await revertPublishes(store, logs.map((l) => l.id)) : [];
  const allReverted = results.every((r) => r.status === "SUCCESS");

  if (allReverted) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "REVERTED", revertedAt: new Date() },
    });

    const productIds = campaign.productIds ? campaign.productIds.split(",").filter(Boolean) : [];
    if (productIds.length > 0) {
      const tagResults = await setProductTag(store, productIds, campaign.tag, "remove");
      const tagFailCount = tagResults.filter((r) => r.status === "ERROR").length;
      if (tagFailCount > 0) {
        console.error(`[campaignEngine] failed to untag ${tagFailCount} product(s) for campaign ${campaignId}`);
      }
    }
  }

  return { campaignId, results };
}

/**
 * Called on the scheduler's recurring tick (see jobs/scheduler.ts) — finds
 * every store's campaigns whose endsAt has passed and that are still
 * ACTIVE, and reverts each. Never throws past a single campaign's failure;
 * logs and moves on, same discipline as every other scheduler tick.
 */
export async function autoRevertDueCampaigns(now: Date = new Date()): Promise<void> {
  const due = await prisma.campaign.findMany({
    where: { status: "ACTIVE", endsAt: { lte: now } },
    include: { store: true },
  });
  for (const campaign of due) {
    try {
      await revertCampaign(campaign.store, campaign.id);
    } catch (err) {
      console.error(`[campaignEngine] auto-revert failed for campaign ${campaign.id}`, err);
    }
  }
}
