import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireSuperAdmin } from "../middleware/auth";

export const fineRulesRouter = Router();

fineRulesRouter.use(requireAuth);

const ruleWithAssignees = {
  assignedUsers: { include: { user: { select: { id: true, name: true } } } },
} as const;

fineRulesRouter.get("/", async (_req, res) => {
  const rules = await prisma.fineRule.findMany({ orderBy: { createdAt: "asc" }, include: ruleWithAssignees });
  res.json(rules);
});

const ruleSchema = z.object({
  name: z.string().min(1),
  baseAmount: z.number().nonnegative(),
  perDayAmount: z.number().nonnegative(),
  graceHours: z.number().nonnegative().default(0),
  maxAmount: z.number().positive().nullable().optional(),
  currency: z.string().default("EUR"),
  active: z.boolean().default(true),
});

// Only the Ultimate Admin decides who gets fined under what terms.
fineRulesRouter.post("/", requireSuperAdmin, async (req, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const rule = await prisma.fineRule.create({ data: parsed.data, include: ruleWithAssignees });
  res.status(201).json(rule);
});

fineRulesRouter.patch("/:id", requireSuperAdmin, async (req, res) => {
  const parsed = ruleSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const rule = await prisma.fineRule.update({ where: { id: req.params.id }, data: parsed.data, include: ruleWithAssignees });
    res.json(rule);
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

fineRulesRouter.delete("/:id", requireSuperAdmin, async (req, res) => {
  try {
    await prisma.fineRule.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

// Which specific accounts this rule applies to. A user can only be pinned to
// one rule at a time, so assigning them here detaches them from whichever
// rule (this one or another) they were on before.
const assigneesSchema = z.object({ userIds: z.array(z.string()) });

fineRulesRouter.put("/:id/assignees", requireSuperAdmin, async (req, res) => {
  const parsed = assigneesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const rule = await prisma.fineRule.findUnique({ where: { id: req.params.id } });
  if (!rule) return res.status(404).json({ error: "Not found" });

  await prisma.$transaction([
    prisma.fineRuleAssignment.deleteMany({ where: { ruleId: req.params.id } }),
    ...parsed.data.userIds.map((userId) =>
      prisma.fineRuleAssignment.upsert({
        where: { userId },
        update: { ruleId: req.params.id },
        create: { userId, ruleId: req.params.id },
      })
    ),
  ]);
  res.json({ ok: true });
});
