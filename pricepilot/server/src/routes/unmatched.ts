import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { normalizeBarcode } from "../lib/textNormalize";
import { resolveMatchesForStore } from "../services/matching";

export const unmatchedRouter = Router();

unmatchedRouter.get("/:storeId", async (req, res) => {
  const sourceId = typeof req.query.sourceId === "string" ? req.query.sourceId : undefined;
  const sources = await prisma.source.findMany({ where: { storeId: req.params.storeId } });
  const sourceIds = sourceId ? [sourceId] : sources.map((s) => s.id);
  const labelBySourceId = new Map(sources.map((s) => [s.id, s.label]));

  const rows = await prisma.competitorPrice.findMany({
    where: { sourceId: { in: sourceIds }, productId: null },
    orderBy: { fetchedAt: "desc" },
  });

  res.json(
    rows.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      sourceLabel: labelBySourceId.get(r.sourceId) ?? r.sourceId,
      matchKey: r.matchKey,
      competitorTitle: r.competitorTitle,
      competitorSku: r.competitorSku,
      competitorBarcode: r.competitorBarcode,
      price: r.price,
      currency: r.currency,
      url: r.url,
      fetchedAt: r.fetchedAt,
    }))
  );
});

const manualMatchSchema = z.object({
  storeId: z.string().min(1),
  sourceId: z.string().min(1),
  productId: z.string().min(1),
  competitorUrlOrEan: z.string().min(1),
  unmatchedCompetitorPriceId: z.string().optional(), // preferred: bind a specific listed row directly
});

unmatchedRouter.post("/manual-match", async (req, res) => {
  const parsed = manualMatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { storeId, sourceId, productId, competitorUrlOrEan, unmatchedCompetitorPriceId } = parsed.data;

  let resolvedMatchKey: string;
  if (unmatchedCompetitorPriceId) {
    const row = await prisma.competitorPrice.findUnique({ where: { id: unmatchedCompetitorPriceId } });
    if (!row || row.sourceId !== sourceId) return res.status(400).json({ error: "Unmatched row not found for this source" });
    resolvedMatchKey = row.matchKey;
  } else if (/^https?:\/\//i.test(competitorUrlOrEan)) {
    const row = await prisma.competitorPrice.findFirst({ where: { sourceId, url: competitorUrlOrEan } });
    if (!row) return res.status(400).json({ error: "No listing found on this source with that URL" });
    resolvedMatchKey = row.matchKey;
  } else {
    resolvedMatchKey = normalizeBarcode(competitorUrlOrEan);
    if (resolvedMatchKey.length < 6) return res.status(400).json({ error: "That doesn't look like a valid EAN" });
  }

  await prisma.manualMatch.upsert({
    where: { sourceId_productId: { sourceId, productId } },
    create: { storeId, sourceId, productId, competitorUrlOrEan, resolvedMatchKey },
    update: { competitorUrlOrEan, resolvedMatchKey },
  });

  await resolveMatchesForStore(storeId);
  res.json({ ok: true });
});

unmatchedRouter.delete("/manual-match/:sourceId/:productId", async (req, res) => {
  await prisma.manualMatch.deleteMany({ where: { sourceId: req.params.sourceId, productId: req.params.productId } });
  const source = await prisma.source.findUnique({ where: { id: req.params.sourceId } });
  if (source) await resolveMatchesForStore(source.storeId);
  res.json({ ok: true });
});
