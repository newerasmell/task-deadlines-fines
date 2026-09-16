import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { createProjectAndNotify } from "../services/projectCreation";

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

const stepSchema = z.object({
  assigneeId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  ownerId: z.string().min(1).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  // Step 1 only.
  deadline: z.coerce.date().optional(),
  // Steps 2-4 only — how many days after the previous step is approved this one's deadline lands.
  delayDays: z.number().int().min(1).max(90).optional(),
});

const createProjectSchema = z
  .object({
    title: z.string().min(1),
    steps: z.array(stepSchema).min(2).max(4),
  })
  .superRefine((data, ctx) => {
    data.steps.forEach((step, i) => {
      if (i === 0 && !step.deadline) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Първата стъпка трябва да има краен срок", path: ["steps", i, "deadline"] });
      }
      if (i > 0 && !step.delayDays) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Всяка следваща стъпка трябва да има брой дни след предходната",
          path: ["steps", i, "delayDays"],
        });
      }
    });
  });

// Same permission rules as POST /tasks, checked independently for every step
// (each step can go to a different person): everyone can self-assign a step
// (needing an Admin Owner if not created by an Admin), a Lead can also
// assign a step to an employee in their scope or to another Lead freely.
// Creating a multi-step project at all requires being an Admin or a Lead —
// it inherently coordinates work across other people, same bar as assigning
// a one-off task to someone else.
projectsRouter.post("/", async (req, res) => {
  const parsed = createProjectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const isAdmin = req.user!.role === "ADMIN";
  const actor = await prisma.user.findUnique({ where: { id: req.user!.sub } });
  if (!isAdmin && !actor?.canAssignTasks) {
    return res.status(403).json({ error: "Нямаш право да създаваш сложни задачи с няколко изпълнители" });
  }

  for (const step of parsed.data.steps) {
    const isSelfAssign = step.assigneeId === req.user!.sub;
    if (!isAdmin && !isSelfAssign) {
      const assignee = await prisma.user.findUnique({ where: { id: step.assigneeId } });
      if (!assignee) return res.status(400).json({ error: `Служител не е намерен: ${step.assigneeId}` });
      if (!assignee.canAssignTasks) {
        const inScope = await prisma.assignmentScope.findUnique({
          where: { leadId_employeeId: { leadId: req.user!.sub, employeeId: step.assigneeId } },
        });
        if (!inScope) {
          return res.status(403).json({ error: `Нямаш право да задаваш задачи на ${assignee.name}` });
        }
      }
    }
  }

  try {
    const { project, steps } = await createProjectAndNotify({ title: parsed.data.title, steps: parsed.data.steps, createdById: req.user!.sub });
    res.status(201).json({ project, steps });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Грешка при създаване на проекта" });
  }
});
