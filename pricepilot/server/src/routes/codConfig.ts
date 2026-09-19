import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

export const codConfigRouter = Router();

async function getOrCreateConfig(storeId: string) {
  const existing = await prisma.codFormulaConfig.findUnique({ where: { storeId } });
  if (existing) return existing;
  return prisma.codFormulaConfig.create({ data: { storeId } });
}

codConfigRouter.get("/:storeId", async (req, res) => {
  const store = await prisma.store.findUnique({ where: { id: req.params.storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });
  const config = await getOrCreateConfig(store.id);
  res.json(config);
});

const scenarioSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  A: z.number().nonnegative(),
  d: z.number().min(0).max(100),
  S: z.number().nonnegative(),
});

const bracketSchema = z.object({
  upper: z.number().positive().nullable(),
  rate: z.number().min(0).max(100),
});

const updateSchema = z.object({
  mode: z.enum(["cost", "target", "breakeven"]).optional(),
  cogsPct: z.number().min(1).max(99).optional(),
  fRate: z.number().min(0).max(99).optional(),
  mRate: z.number().min(0).max(99).optional(),
  nItems: z.number().positive().optional(),
  rMult: z.number().min(1).optional(),
  lLoss: z.number().min(0).max(100).optional(),
  fCost: z.number().nonnegative().optional(),
  roundStep: z.number().positive().optional(),
  discountPct: z.number().min(1).max(90).optional(),
  discountTag: z.string().min(1).optional(),
  pricingScenario: z.enum(["pess", "avg", "opt"]).optional(),
  pricingN: z.number().positive().optional(),
  scenarios: z.array(scenarioSchema).length(3).optional(),
  brackets: z.array(bracketSchema).min(1).optional(),
});

codConfigRouter.patch("/:storeId", async (req, res) => {
  const store = await prisma.store.findUnique({ where: { id: req.params.storeId } });
  if (!store) return res.status(404).json({ error: "Store not found" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await getOrCreateConfig(store.id); // ensures a row exists before the update below

  const { scenarios, brackets, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };
  if (scenarios) data.scenariosJson = JSON.stringify(scenarios);
  if (brackets) data.bracketsJson = JSON.stringify(brackets);

  const config = await prisma.codFormulaConfig.update({ where: { storeId: store.id }, data });
  res.json(config);
});
