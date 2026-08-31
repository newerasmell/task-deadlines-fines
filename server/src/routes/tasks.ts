import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

tasksRouter.get("/", async (req, res) => {
  const isAdmin = req.user!.role === "ADMIN";
  const assigneeFilter = typeof req.query.assigneeId === "string" ? req.query.assigneeId : undefined;

  const tasks = await prisma.task.findMany({
    where: isAdmin ? (assigneeFilter ? { assigneeId: assigneeFilter } : {}) : { assigneeId: req.user!.sub },
    include: {
      assignee: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      fines: true,
    },
    orderBy: { deadline: "asc" },
  });
  res.json(tasks);
});

tasksRouter.get("/:id", async (req, res) => {
  const task = await prisma.task.findUnique({
    where: { id: req.params.id },
    include: {
      assignee: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      fines: true,
      notificationLogs: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!task) return res.status(404).json({ error: "Not found" });
  if (req.user!.role !== "ADMIN" && task.assigneeId !== req.user!.sub) {
    return res.status(403).json({ error: "Not allowed" });
  }
  res.json(task);
});

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeId: z.string().min(1),
  deadline: z.coerce.date(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
});

tasksRouter.post("/", requireAdmin, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const assignee = await prisma.user.findUnique({ where: { id: parsed.data.assigneeId } });
  if (!assignee) return res.status(400).json({ error: "Assignee not found" });

  const task = await prisma.task.create({
    data: { ...parsed.data, createdById: req.user!.sub },
    include: { assignee: true },
  });

  const target = toNotificationTarget(assignee);
  await dispatchToAllChannels(
    target,
    {
      subject: `Нова задача: ${task.title}`,
      body: `Получи нова задача със срок ${task.deadline.toLocaleString("bg-BG")}.\n\n${task.description ?? ""}\n\nЗакъснението без основателна причина води до автоматична глоба.`,
      deadline: task.deadline,
    },
    { taskId: task.id }
  );

  res.status(201).json(task);
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  assigneeId: z.string().min(1).optional(),
  deadline: z.coerce.date().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  status: z.enum(["PENDING", "IN_PROGRESS", "DONE", "OVERDUE", "CANCELLED"]).optional(),
});

tasksRouter.patch("/:id", async (req, res) => {
  const existing = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const isAdmin = req.user!.role === "ADMIN";
  const isOwner = existing.assigneeId === req.user!.sub;
  if (!isAdmin && !isOwner) return res.status(403).json({ error: "Not allowed" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };
  if (!isAdmin) {
    // Employees can only move status forward (e.g. to DONE), not reassign or change deadlines.
    for (const key of ["title", "description", "assigneeId", "deadline", "priority"]) delete data[key];
  }
  if (parsed.data.status === "DONE" && existing.status !== "DONE") {
    data.completedAt = new Date();
  }

  const task = await prisma.task.update({ where: { id: req.params.id }, data });
  res.json(task);
});

tasksRouter.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.task.update({ where: { id: req.params.id }, data: { status: "CANCELLED" } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});
