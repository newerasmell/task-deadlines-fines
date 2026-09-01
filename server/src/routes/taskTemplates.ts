import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const taskTemplatesRouter = Router();

taskTemplatesRouter.use(requireAuth);

const WEEKDAY_CODES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
const timeOfDayRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

const templateInclude = {
  assignee: { select: { id: true, name: true, email: true } },
  owner: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
} as const;

taskTemplatesRouter.get("/", async (req, res) => {
  const isAdmin = req.user!.role === "ADMIN";
  const templates = await prisma.recurringTaskTemplate.findMany({
    where: isAdmin ? {} : { OR: [{ assigneeId: req.user!.sub }, { ownerId: req.user!.sub }] },
    include: templateInclude,
    orderBy: { createdAt: "desc" },
  });
  res.json(templates);
});

const templateSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeId: z.string().min(1),
  ownerId: z.string().min(1).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  daysOfWeek: z.array(z.enum(WEEKDAY_CODES)).min(1),
  timeOfDay: z.string().regex(timeOfDayRegex, "Expected HH:MM"),
  active: z.boolean().default(true),
});

taskTemplatesRouter.post("/", requireAdmin, async (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const assignee = await prisma.user.findUnique({ where: { id: parsed.data.assigneeId } });
  if (!assignee) return res.status(400).json({ error: "Assignee not found" });
  if (parsed.data.ownerId) {
    const owner = await prisma.user.findUnique({ where: { id: parsed.data.ownerId } });
    if (!owner) return res.status(400).json({ error: "Owner not found" });
  }

  const template = await prisma.recurringTaskTemplate.create({
    data: { ...parsed.data, daysOfWeek: parsed.data.daysOfWeek.join(","), createdById: req.user!.sub },
    include: templateInclude,
  });
  res.status(201).json(template);
});

const updateSchema = templateSchema.partial();

taskTemplatesRouter.patch("/:id", requireAdmin, async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.daysOfWeek) data.daysOfWeek = parsed.data.daysOfWeek.join(",");

  try {
    const template = await prisma.recurringTaskTemplate.update({
      where: { id: req.params.id },
      data,
      include: templateInclude,
    });
    res.json(template);
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

// A hard delete, unlike the active toggle above (which just pauses future
// occurrences) — already-spawned Task rows keep their own copied data and
// simply lose their back-reference (templateId set null), so nothing about
// past occurrences is lost.
taskTemplatesRouter.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.recurringTaskTemplate.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});
