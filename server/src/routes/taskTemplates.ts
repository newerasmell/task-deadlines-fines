import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

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
    where: isAdmin
      ? {}
      : { OR: [{ assigneeId: req.user!.sub }, { ownerId: req.user!.sub }, { createdById: req.user!.sub }] },
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

// Same permission rules as POST /tasks: everyone can create a recurring
// template for themselves; a Lead can also create one for an employee in
// their scope (or for another Lead, freely); a self-assigned template still
// needs an Admin as Owner, since nobody should be reviewing their own work.
taskTemplatesRouter.post("/", async (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const isAdmin = req.user!.role === "ADMIN";
  const isSelfAssign = parsed.data.assigneeId === req.user!.sub;

  const assignee = await prisma.user.findUnique({ where: { id: parsed.data.assigneeId } });
  if (!assignee) return res.status(400).json({ error: "Assignee not found" });

  if (!isAdmin && !isSelfAssign) {
    const actor = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!actor?.canAssignTasks) {
      return res.status(403).json({ error: "Нямаш право да задаваш задачи на други служители" });
    }
    if (!assignee.canAssignTasks) {
      const inScope = await prisma.assignmentScope.findUnique({
        where: { leadId_employeeId: { leadId: req.user!.sub, employeeId: parsed.data.assigneeId } },
      });
      if (!inScope) {
        return res.status(403).json({ error: "Нямаш право да задаваш задачи на този служител" });
      }
    }
  }

  if (parsed.data.ownerId && parsed.data.ownerId === parsed.data.assigneeId) {
    return res.status(400).json({ error: "Owner-ът не може да е самият изпълнител" });
  }
  if (isSelfAssign && !isAdmin) {
    if (!parsed.data.ownerId) {
      return res.status(400).json({ error: "Самозададена задача трябва да има Owner — администратор, който да следи изпълнението" });
    }
    const owner = await prisma.user.findUnique({ where: { id: parsed.data.ownerId } });
    if (!owner || owner.role !== "ADMIN") {
      return res.status(400).json({ error: "Owner-ът на самозададена задача трябва да е администратор" });
    }
  }

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

const updateSchema = templateSchema.partial().extend({
  ownerId: z.string().nullable().optional(),
});

// Editing after creation stays close to how a one-off task works: only an
// Admin can edit/delete a template someone else set up for you or for a
// scope employee. The one exception is a fully self-service template — you
// created it and you're the assignee — since that's just your own personal
// automation and nobody else's oversight is at stake.
function canManage(template: { assigneeId: string; createdById: string }, userId: string, isAdmin: boolean) {
  return isAdmin || (template.createdById === userId && template.assigneeId === userId);
}

taskTemplatesRouter.patch("/:id", async (req, res) => {
  const existing = await prisma.recurringTaskTemplate.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!canManage(existing, req.user!.sub, req.user!.role === "ADMIN")) {
    return res.status(403).json({ error: "Not allowed" });
  }

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
taskTemplatesRouter.delete("/:id", async (req, res) => {
  const existing = await prisma.recurringTaskTemplate.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!canManage(existing, req.user!.sub, req.user!.role === "ADMIN")) {
    return res.status(403).json({ error: "Not allowed" });
  }

  try {
    await prisma.recurringTaskTemplate.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});
