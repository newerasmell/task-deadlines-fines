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
