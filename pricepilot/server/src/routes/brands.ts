import { Router } from "express";
import { z } from "zod";
import { logAudit } from "../lib/audit";
import { prisma } from "../lib/prisma";

export const brandsRouter = Router();

// Every distinct vendor actually selling in this store's catalog, each
// paired with its coefficient if one's been set (null otherwise) — driven
// off Product.vendor rather than the Brand table alone, so a brand that's
// never been given a coefficient still shows up as a row to fill in,
// instead of silently not existing until someone thinks to add it.
brandsRouter.get("/:storeId", async (req, res) => {
  const [vendorGroups, brands] = await Promise.all([
    prisma.product.groupBy({
      by: ["vendor"],
      where: { storeId: req.params.storeId, vendor: { not: null } },
      _count: { _all: true },
    }),
    prisma.brand.findMany({ where: { storeId: req.params.storeId } }),
  ]);

  const coefficientByVendor = new Map(brands.map((b) => [b.vendor, b.coefficient]));
  const rows = vendorGroups
    .filter((g): g is typeof g & { vendor: string } => g.vendor != null)
    .map((g) => ({
      vendor: g.vendor,
      productCount: g._count._all,
      coefficient: coefficientByVendor.get(g.vendor) ?? null,
    }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));

  res.json(rows);
});

const coefficientSchema = z.object({ vendor: z.string().min(1), coefficient: z.number().min(1).max(10) });

brandsRouter.put("/:storeId/coefficient", async (req, res) => {
  const parsed = coefficientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const brand = await prisma.brand.upsert({
    where: { storeId_vendor: { storeId: req.params.storeId, vendor: parsed.data.vendor } },
    create: { storeId: req.params.storeId, vendor: parsed.data.vendor, coefficient: parsed.data.coefficient },
    update: { coefficient: parsed.data.coefficient },
  });
  await logAudit(
    req.userId!,
    "BRAND_COEFFICIENT_UPDATED",
    "Brand",
    brand.id,
    `Set price coefficient of "${parsed.data.vendor}" to ${parsed.data.coefficient}`
  );
  res.json(brand);
});

brandsRouter.delete("/:storeId/coefficient/:vendor", async (req, res) => {
  await prisma.brand.deleteMany({ where: { storeId: req.params.storeId, vendor: req.params.vendor } });
  await logAudit(req.userId!, "BRAND_COEFFICIENT_UPDATED", "Brand", null, `Cleared price coefficient of "${req.params.vendor}"`);
  res.json({ ok: true });
});

const copyToSchema = z.object({ targetStoreIds: z.array(z.string().min(1)).min(1) });

// Clothing brands price the same the world over, so a chain running several
// COD storefronts sets one store's coefficients once and clones them onto
// the rest here, instead of re-typing the same 1-10 ranking store by store.
// Overwrites whatever coefficient a target store already had for a vendor
// they share with the source (that's the point — keep them in sync), but
// never touches a target-only vendor the source doesn't sell.
brandsRouter.post("/:storeId/copy-to", async (req, res) => {
  const parsed = copyToSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const sourceStoreId = req.params.storeId;
  const targetStoreIds = [...new Set(parsed.data.targetStoreIds)].filter((id) => id !== sourceStoreId);
  if (targetStoreIds.length === 0) return res.status(400).json({ error: "No valid target stores." });

  const [sourceStore, sourceBrandsRaw, sourceVendorGroups, targetStores] = await Promise.all([
    prisma.store.findUnique({ where: { id: sourceStoreId } }),
    prisma.brand.findMany({ where: { storeId: sourceStoreId, coefficient: { not: null } } }),
    prisma.product.groupBy({ by: ["vendor"], where: { storeId: sourceStoreId, vendor: { not: null } } }),
    prisma.store.findMany({ where: { id: { in: targetStoreIds } } }),
  ]);
  if (!sourceStore) return res.status(404).json({ error: "Source store not found." });
  if (targetStores.length !== targetStoreIds.length) return res.status(404).json({ error: "One or more target stores not found." });

  // Only vendors this store actually sells right now — matches the rows
  // shown on the tab itself, so a stale coefficient left over from a
  // discontinued brand never silently reappears on another store.
  const sellingVendors = new Set(sourceVendorGroups.map((g) => g.vendor));
  const sourceBrands = sourceBrandsRaw.filter((b) => sellingVendors.has(b.vendor));
  if (sourceBrands.length === 0) return res.status(400).json({ error: "Source store has no brand coefficients to copy." });

  await prisma.$transaction(
    targetStores.flatMap((store) =>
      sourceBrands.map((b) =>
        prisma.brand.upsert({
          where: { storeId_vendor: { storeId: store.id, vendor: b.vendor } },
          create: { storeId: store.id, vendor: b.vendor, coefficient: b.coefficient },
          update: { coefficient: b.coefficient },
        })
      )
    )
  );

  for (const store of targetStores) {
    await logAudit(
      req.userId!,
      "BRAND_COEFFICIENT_UPDATED",
      "Store",
      store.id,
      `Copied ${sourceBrands.length} brand coefficient(s) from "${sourceStore.name}" onto "${store.name}"`
    );
  }

  res.json({ copiedBrands: sourceBrands.length, targetStoreCount: targetStores.length });
});
