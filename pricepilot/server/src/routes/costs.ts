import { parse } from "csv-parse/sync";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

export const costsRouter = Router();

costsRouter.get("/:storeId", async (req, res) => {
  const costs = await prisma.cost.findMany({ where: { storeId: req.params.storeId }, orderBy: { skuOrEan: "asc" } });
  res.json(costs);
});

const importSchema = z.object({
  storeId: z.string().min(1),
  csv: z.string().min(1),
});

// CSV columns, header optional: sku_or_ean,cost (also accepts "sku"/"ean"/
// "cost" as header names — matched case-insensitively — or two bare
// columns with no header at all).
costsRouter.post("/import", async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let records: string[][];
  try {
    records = parse(parsed.data.csv, { skip_empty_lines: true, trim: true }) as string[][];
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err instanceof Error ? err.message : "invalid format"}` });
  }
  if (records.length === 0) return res.status(400).json({ error: "CSV has no rows" });

  const headerLooking = records[0].map((c) => c.toLowerCase());
  const hasHeader = headerLooking.some((c) => ["sku", "ean", "sku_or_ean", "cost"].includes(c));
  const dataRows = hasHeader ? records.slice(1) : records;

  let imported = 0;
  const errors: string[] = [];
  for (const [i, row] of dataRows.entries()) {
    const [skuOrEan, costRaw] = row;
    const cost = Number(costRaw);
    if (!skuOrEan || Number.isNaN(cost)) {
      errors.push(`Row ${i + 1}: invalid data (${JSON.stringify(row)})`);
      continue;
    }
    await prisma.cost.upsert({
      where: { storeId_skuOrEan: { storeId: parsed.data.storeId, skuOrEan: skuOrEan.trim() } },
      create: { storeId: parsed.data.storeId, skuOrEan: skuOrEan.trim(), cost },
      update: { cost },
    });
    imported++;
  }

  res.json({ imported, errorCount: errors.length, errors: errors.slice(0, 20) });
});
