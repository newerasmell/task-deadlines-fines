import { parse } from "csv-parse/sync";
import { Router } from "express";
import { z } from "zod";
import { extractMlFromTitle } from "../lib/htmlPriceParser";
import { prisma } from "../lib/prisma";
import {
  buildSearchUrl,
  isSourceRefreshing,
  recordFoundPrice,
  recordNotFound,
  refreshSource,
} from "../services/competitorCollection";
import { resolveMatchesForStore } from "../services/matching";

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
  type: z.enum(["shopify_json", "scrape", "manual_import", "jeftinije_hr", "notino_hr"]),
  baseUrl: z.string().min(1),
  searchUrlTemplate: z.string().nullable().optional(),
  active: z.boolean().default(true),
  // jeftinije_hr's full brand-listing crawl is heavy enough that it
  // defaults to manual-only ("Refresh now" button, no 24h auto-tick)
  // unless explicitly opted into the scheduler; every other type keeps
  // today's always-automatic behavior unless told otherwise. notino_hr is
  // the same style of brand-listing crawl (currently a single-brand test),
  // manual-only for the same reason.
  autoRefresh: z.boolean().optional(),
});

sourcesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existingCount = await prisma.source.count({ where: { storeId: parsed.data.storeId } });
  if (existingCount >= MAX_SOURCES_PER_STORE) {
    return res.status(400).json({ error: `A store can have at most ${MAX_SOURCES_PER_STORE} sources` });
  }

  const autoRefresh = parsed.data.autoRefresh ?? (parsed.data.type !== "jeftinije_hr" && parsed.data.type !== "notino_hr");
  const source = await prisma.source.create({ data: { ...parsed.data, autoRefresh } });
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
  // No real per-user login yet (a single shared dashboard password) — see
  // Source.lastTriggeredBy in the schema for why this is a fixed "Admin"
  // rather than something read off req.
  void refreshSource(sourceId, "Admin").catch((err) => {
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

// Pending candidates a jeftinije_hr-style source found more than one
// plausible listing for — the admin picks the right one (or none) instead
// of the crawl guessing. See AmbiguousMatch in schema.prisma.
sourcesRouter.get("/:id/ambiguous", async (req, res) => {
  const matches = await prisma.ambiguousMatch.findMany({
    where: { sourceId: req.params.id, status: "pending" },
    orderBy: { createdAt: "asc" },
    include: { product: { select: { title: true, vendor: true, sku: true, price: true } } },
  });
  res.json(
    matches.map((m) => ({
      id: m.id,
      productId: m.productId,
      productTitle: m.product.title,
      productVendor: m.product.vendor,
      productSku: m.product.sku,
      ourPrice: m.product.price,
      candidates: JSON.parse(m.candidatesJson) as {
        title: string;
        price: number | null;
        url: string;
        sizeUnconfirmed?: boolean;
      }[],
      createdAt: m.createdAt,
    }))
  );
});

const confirmAmbiguousSchema = z.object({ price: z.number(), url: z.string().min(1) });

sourcesRouter.post("/ambiguous/:id/confirm", async (req, res) => {
  const parsed = confirmAmbiguousSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const match = await prisma.ambiguousMatch.findUnique({
    where: { id: req.params.id },
    include: { source: { include: { store: true } }, product: true },
  });
  if (!match) return res.status(404).json({ error: "Not found" });

  await recordFoundPrice({ source: match.source, store: match.source.store, product: match.product, ...parsed.data });
  await prisma.ambiguousMatch.update({ where: { id: match.id }, data: { status: "resolved", resolvedAt: new Date() } });
  await resolveMatchesForStore(match.source.storeId);
  res.json({ ok: true });
});

sourcesRouter.post("/ambiguous/:id/dismiss", async (req, res) => {
  try {
    await prisma.ambiguousMatch.update({
      where: { id: req.params.id },
      data: { status: "dismissed", resolvedAt: new Date() },
    });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const EXPORT_HEADER = [
  "product_id",
  "sku",
  "vendor",
  "title",
  "size_ml",
  "our_price",
  "search_url",
  "competitor_price",
  "competitor_url",
  "not_found",
];

// Round-trip research template for a `manual_import` source: a Cowork agent
// (or a person) can't reliably be pointed at a live headless browser — some
// of these sites block automated fetches outright — so instead they search
// the site by hand, fill in `competitor_price`/`competitor_url` (or mark
// `not_found`) on this same file, and it comes back in via /import below.
// `product_id` is the only column the import actually trusts for matching:
// it's included specifically so a missing/duplicate SKU can never cause a
// row to land on the wrong product.
sourcesRouter.get("/:id/export-template", async (req, res) => {
  const source = await prisma.source.findUnique({ where: { id: req.params.id } });
  if (!source) return res.status(404).json({ error: "Source not found" });

  const products = await prisma.product.findMany({ where: { storeId: source.storeId }, orderBy: { title: "asc" } });
  const rows = products.map((p) => [
    p.id,
    p.sku ?? "",
    p.vendor ?? "",
    p.title,
    extractMlFromTitle(p.title) ?? "",
    p.price,
    source.searchUrlTemplate ? buildSearchUrl(source.searchUrlTemplate, p) : source.baseUrl,
    "",
    "",
    "",
  ]);
  const csv = [EXPORT_HEADER, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
  const filename = `${source.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-research-template.csv`;
  res.json({ csv, filename });
});

const importSchema = z.object({ csv: z.string().min(1) });

sourcesRouter.post("/:id/import", async (req, res) => {
  const source = await prisma.source.findUnique({ where: { id: req.params.id }, include: { store: true } });
  if (!source) return res.status(404).json({ error: "Source not found" });

  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let records: Record<string, string>[];
  try {
    const raw = parse(parsed.data.csv, { columns: true, skip_empty_lines: true, trim: true }) as Record<
      string,
      string
    >[];
    // Header names are matched case-insensitively — the export template
    // ships them lowercase, but a spreadsheet app can re-save a header row
    // capitalized without anyone noticing.
    records = raw.map((row) => {
      const normalized: Record<string, string> = {};
      for (const [key, value] of Object.entries(row)) normalized[key.trim().toLowerCase()] = (value ?? "").trim();
      return normalized;
    });
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err instanceof Error ? err.message : "invalid format"}` });
  }
  if (records.length === 0) return res.status(400).json({ error: "CSV has no rows" });

  const products = await prisma.product.findMany({ where: { storeId: source.storeId } });
  const productById = new Map(products.map((p) => [p.id, p]));

  let matched = 0;
  let notFoundCount = 0;
  const errors: string[] = [];
  for (const [i, row] of records.entries()) {
    const productId = row.product_id;
    if (!productId) continue; // blank row — ignore rather than error, common at the end of a sheet
    const product = productById.get(productId);
    if (!product) {
      errors.push(`Row ${i + 2}: unknown product_id "${productId}" (was this row edited?)`);
      continue;
    }

    const priceRaw = row.competitor_price;
    const markedNotFound = /^(y|yes|true|1|x)$/i.test(row.not_found ?? "");

    if (priceRaw) {
      const price = parseFloat(priceRaw.replace(",", "."));
      if (Number.isNaN(price) || price <= 0) {
        errors.push(`Row ${i + 2}: invalid competitor_price "${priceRaw}"`);
        continue;
      }
      const url = row.competitor_url || row.search_url || source.baseUrl;
      await recordFoundPrice({ source, store: source.store, product, price, url });
      matched++;
    } else if (markedNotFound) {
      const url = row.search_url || source.baseUrl;
      await recordNotFound({ sourceId: source.id, productId: product.id, url, error: "Marked not found on import" });
      notFoundCount++;
    }
    // Neither filled in — not yet researched, leave whatever's on file alone.
  }

  await prisma.source.update({
    where: { id: source.id },
    data: { lastRefreshedAt: new Date(), lastMatchedCount: matched, lastError: null },
  });

  await resolveMatchesForStore(source.storeId);

  res.json({ matched, notFoundCount, errorCount: errors.length, errors: errors.slice(0, 20) });
});

// Round-trips match_products.py's ambiguous_review.csv (one row per
// candidate, several rows per product_id) into the same AmbiguousMatch
// review queue the automated jeftinije_hr crawl uses — so a manual_import
// source's uncertain matches get the same pick-a-candidate UI instead of
// requiring the CSV itself to be hand-edited.
const importAmbiguousSchema = z.object({ csv: z.string().min(1) });

sourcesRouter.post("/:id/import-ambiguous", async (req, res) => {
  const source = await prisma.source.findUnique({ where: { id: req.params.id } });
  if (!source) return res.status(404).json({ error: "Source not found" });

  const parsed = importAmbiguousSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let records: Record<string, string>[];
  try {
    const raw = parse(parsed.data.csv, { columns: true, skip_empty_lines: true, trim: true }) as Record<
      string,
      string
    >[];
    records = raw.map((row) => {
      const normalized: Record<string, string> = {};
      for (const [key, value] of Object.entries(row)) normalized[key.trim().toLowerCase()] = (value ?? "").trim();
      return normalized;
    });
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err instanceof Error ? err.message : "invalid format"}` });
  }
  if (records.length === 0) return res.status(400).json({ error: "CSV has no rows" });

  const products = await prisma.product.findMany({ where: { storeId: source.storeId } });
  const productIds = new Set(products.map((p) => p.id));

  const byProduct = new Map<string, { title: string; price: number | null; url: string }[]>();
  const errors: string[] = [];
  for (const [i, row] of records.entries()) {
    const productId = row.product_id;
    if (!productId) continue; // blank row — ignore, common at the end of a sheet
    if (!productIds.has(productId)) {
      errors.push(`Row ${i + 2}: unknown product_id "${productId}" (was this row edited?)`);
      continue;
    }
    const title = row.candidate_title;
    const url = row.candidate_url;
    if (!title || !url) {
      errors.push(`Row ${i + 2}: missing candidate_title/candidate_url`);
      continue;
    }
    const priceRaw = row.candidate_price;
    const parsedPrice = priceRaw ? parseFloat(priceRaw.replace(",", ".")) : NaN;
    const price = Number.isNaN(parsedPrice) ? null : parsedPrice;
    const list = byProduct.get(productId) ?? [];
    list.push({ title, price, url });
    byProduct.set(productId, list);
  }

  let imported = 0;
  for (const [productId, candidates] of byProduct) {
    // Same "leave an already-resolved/dismissed row alone unless the
    // candidate set changed" rule the automated crawl's upsert uses — a
    // re-import of the same review file shouldn't re-litigate a decision
    // already made.
    const candidatesJson = JSON.stringify(candidates.slice(0, 5));
    const existing = await prisma.ambiguousMatch.findUnique({
      where: { sourceId_productId: { sourceId: source.id, productId } },
    });
    if (existing && existing.status !== "pending" && existing.candidatesJson === candidatesJson) continue;
    await prisma.ambiguousMatch.upsert({
      where: { sourceId_productId: { sourceId: source.id, productId } },
      create: { sourceId: source.id, productId, candidatesJson, status: "pending" },
      update: { candidatesJson, status: "pending", resolvedAt: null },
    });
    imported++;
  }

  res.json({ imported, errorCount: errors.length, errors: errors.slice(0, 20) });
});
