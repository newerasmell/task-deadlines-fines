import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { isSourceRefreshing, refreshSource } from "../services/competitorCollection";

export const sourcesRouter = Router();

// Was 3 per the original brief; raised to 4 at the user's request.
const MAX_SOURCES_PER_STORE = 4;

sourcesRouter.get("/", async (req, res) => {
  const storeId = typeof req.query.storeId === "string" ? req.query.storeId : undefined;
  const sources = await prisma.source.findMany({
    where: storeId ? { storeId } : {},
    orderBy: { label: "asc" },
  });
  res.json(sources);
});

const createSchema = z.object({
  storeId: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["shopify_json", "scrape"]),
  baseUrl: z.string().min(1),
  searchUrlTemplate: z.string().nullable().optional(),
  active: z.boolean().default(true),
});

sourcesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existingCount = await prisma.source.count({ where: { storeId: parsed.data.storeId } });
  if (existingCount >= MAX_SOURCES_PER_STORE) {
    return res.status(400).json({ error: `A store can have at most ${MAX_SOURCES_PER_STORE} sources` });
  }

  const source = await prisma.source.create({ data: parsed.data });
  res.status(201).json(source);
});

const updateSchema = createSchema.partial();

// Changing where/how a source fetches prices makes it a functionally
// different source, even though it keeps the same row/id — everything
// collected under the old identity (which competitor site actually
// answered, at what URL) no longer describes reality. Editing type/baseUrl/
// searchUrlTemplate without clearing this out left exactly that: a source
// relabeled from jeftinije.hr to zivada.hr while its results panel kept
// showing old jeftinije.hr URLs under the new name.
const IDENTITY_FIELDS = ["type", "baseUrl", "searchUrlTemplate"] as const;

sourcesRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.source.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Source not found" });

  const identityChanged = IDENTITY_FIELDS.some(
    (field) => field in parsed.data && parsed.data[field] !== existing[field]
  );

  try {
    const source = await prisma.$transaction(async (tx) => {
      if (identityChanged) {
        await tx.scrapeAttempt.deleteMany({ where: { sourceId: existing.id } });
        await tx.competitorPrice.deleteMany({ where: { sourceId: existing.id } });
        await tx.competitorPriceHistory.deleteMany({ where: { sourceId: existing.id } });
        await tx.manualMatch.deleteMany({ where: { sourceId: existing.id } });
      }
      return tx.source.update({
        where: { id: existing.id },
        data: {
          ...parsed.data,
          ...(identityChanged
            ? { lastRefreshedAt: null, lastMatchedCount: null, consecutiveFailures: 0, degraded: false, lastError: null }
            : {}),
        },
      });
    });
    res.json(source);
  } catch {
    res.status(404).json({ error: "Source not found" });
  }
});

sourcesRouter.delete("/:id", async (req, res) => {
  try {
    await prisma.source.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "Source not found" });
  }
});

sourcesRouter.post("/:id/refresh", async (req, res) => {
  const sourceId = req.params.id;
  const source = await prisma.source.findUnique({ where: { id: sourceId } });
  if (!source) return res.status(404).json({ error: "Source not found" });

  if (isSourceRefreshing(sourceId)) {
    return res.json({ ok: true, started: false, alreadyRunning: true });
  }

  // Fire-and-forget: a scrape refresh can run for several minutes (polite
  // ~2-3s delay per product, up to ~140 targets), far too long to hold an
  // HTTP request/proxy connection open for. refreshSource() persists its
  // result to the source row regardless of outcome — the client polls
  // GET /sources and reads lastRefreshedAt/lastMatchedCount/lastError from
  // there instead of waiting on this response.
  void refreshSource(sourceId).catch((err) => {
    console.error(`[sources] background refresh failed for ${sourceId}:`, err);
  });

  res.json({ ok: true, started: true });
});

// Per-product results for a scrape source — always the latest attempt per
// product (see ScrapeAttempt in schema.prisma), not a full historical log.
// Lets Settings show which specific products were actually searched and
// whether a price was found, not just an aggregate count.
sourcesRouter.get("/:id/attempts", async (req, res) => {
  const attempts = await prisma.scrapeAttempt.findMany({
    where: { sourceId: req.params.id },
    orderBy: { attemptedAt: "desc" },
    include: { product: { select: { title: true, vendor: true, sku: true } } },
  });
  res.json(
    attempts.map((a) => ({
      id: a.id,
      productId: a.productId,
      productTitle: a.product.title,
      productVendor: a.product.vendor,
      productSku: a.product.sku,
      found: a.found,
      price: a.price,
      error: a.error,
      url: a.url,
      attemptedAt: a.attemptedAt,
    }))
  );
});
