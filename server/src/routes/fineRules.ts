import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const fineRulesRouter = Router();

fineRulesRouter.use(requireAuth);

fineRulesRouter.get("/", async (_req, res) => {
  const rules = await prisma.fineRule.findMany({ orderBy: { createdAt: "asc" } });
  res.json(rules);
});

const ruleSchema = z.object({
  name: z.string().min(1),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).nullable().optional(),
  baseAmount: z.number().nonnegative(),
  perDayAmount: z.number().nonnegative(),
  graceHours: z.number().nonnegative().default(0),
  maxAmount: z.number().positive().nullable().optional(),
  currency: z.string().default("BGN"),
  active: z.boolean().default(true),
});

fineRulesRouter.post("/", requireAdmin, async (req, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const rule = await prisma.fineRule.create({ data: parsed.data });
  res.status(201).json(rule);
});

fineRulesRouter.patch("/:id", requireAdmin, async (req, res) => {
  const parsed = ruleSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const rule = await prisma.fineRule.update({ where: { id: req.params.id }, data: parsed.data });
    res.json(rule);
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

fineRulesRouter.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.fineRule.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});
