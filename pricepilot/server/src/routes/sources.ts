import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { refreshSource } from "../services/competitorCollection";

export const sourcesRouter = Router();

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
  if (existingCount >= 3) {
    return res.status(400).json({ error: "A store can have at most 3 sources" });
  }

  const source = await prisma.source.create({ data: parsed.data });
  res.status(201).json(source);
});

const updateSchema = createSchema.partial();

sourcesRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const source = await prisma.source.update({ where: { id: req.params.id }, data: parsed.data });
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
  try {
    const result = await refreshSource(req.params.id);
    res.json(result);
  } catch {
    res.status(404).json({ error: "Source not found" });
  }
});
