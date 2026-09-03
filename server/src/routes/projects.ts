import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { formatDateTime } from "../lib/dateFormat";
import { logAction } from "../lib/auditLog";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

// A step past the first has no real deadline yet — this placeholder is never
// acted on by the scanner (status stays "BLOCKED", which isn't in any status
// list the scanner scans) until the approve route replaces it with a real
// one once the previous step is approved.
const FAR_FUTURE_PLACEHOLDER = new Date("9999-12-31T00:00:00.000Z");

const stepInclude = {
  assignee: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      telegramChatId: true,
      slackMemberId: true,
      whatsappPhone: true,
      viberUserId: true,
      googleCalendarId: true,
    },
  },
  owner: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      telegramChatId: true,
      slackMemberId: true,
      whatsappPhone: true,
      viberUserId: true,
      googleCalendarId: true,
    },
  },
} satisfies Prisma.TaskInclude;

type StepTask = Prisma.TaskGetPayload<{ include: typeof stepInclude }>;

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
    const assignee = await prisma.user.findUnique({ where: { id: step.assigneeId } });
    if (!assignee) return res.status(400).json({ error: `Служител не е намерен: ${step.assigneeId}` });

    if (!isAdmin && !isSelfAssign && !assignee.canAssignTasks) {
      const inScope = await prisma.assignmentScope.findUnique({
        where: { leadId_employeeId: { leadId: req.user!.sub, employeeId: step.assigneeId } },
      });
      if (!inScope) {
        return res.status(403).json({ error: `Нямаш право да задаваш задачи на ${assignee.name}` });
      }
    }

    if (step.ownerId && step.ownerId === step.assigneeId) {
      return res.status(400).json({ error: `Owner-ът не може да е самият изпълнител ("${step.title}")` });
    }
    if (isSelfAssign && !isAdmin) {
      if (!step.ownerId) {
        return res.status(400).json({ error: `Самозададена стъпка ("${step.title}") трябва да има Owner — администратор` });
      }
      const owner = await prisma.user.findUnique({ where: { id: step.ownerId } });
      if (!owner || owner.role !== "ADMIN") {
        return res.status(400).json({ error: `Owner-ът на самозададена стъпка ("${step.title}") трябва да е администратор` });
      }
    }
    if (step.ownerId) {
      const owner = await prisma.user.findUnique({ where: { id: step.ownerId } });
      if (!owner) return res.status(400).json({ error: "Owner not found" });
    }
  }

  const project = await prisma.project.create({ data: { title: parsed.data.title, createdById: req.user!.sub } });

  const createdTasks: StepTask[] = [];
  let previousStepId: string | null = null;

  for (let i = 0; i < parsed.data.steps.length; i++) {
    const step = parsed.data.steps[i];
    const isFirst = i === 0;
    const stepTask: StepTask = await prisma.task.create({
      data: {
        title: step.title,
        description: step.description,
        assigneeId: step.assigneeId,
        ownerId: step.ownerId,
        createdById: req.user!.sub,
        priority: step.priority,
        deadline: isFirst ? step.deadline! : FAR_FUTURE_PLACEHOLDER,
        status: isFirst ? "PENDING" : "BLOCKED",
        projectId: project.id,
        chainOrder: i + 1,
        delayDaysAfterPrevious: isFirst ? null : step.delayDays,
        previousStepId: isFirst ? null : previousStepId,
      },
      include: stepInclude,
    });
    createdTasks.push(stepTask);
    previousStepId = stepTask.id;
  }

  // Notify every step's assignee and owner about the whole chain up front —
  // even for a step that won't start for a while, so nobody is caught by
  // surprise once their turn actually comes.
  for (let i = 0; i < createdTasks.length; i++) {
    const task = createdTasks[i];
    const isFirst = i === 0;
    const prevTitle = isFirst ? null : createdTasks[i - 1].title;
    const delayText = task.delayDaysAfterPrevious
      ? `${task.delayDaysAfterPrevious} ${task.delayDaysAfterPrevious === 1 ? "ден" : "дни"}`
      : "";

    const assigneeBody = isFirst
      ? `Част си от проект "${project.title}". Твоята стъпка "${task.title}" е активна веднага — срок ${formatDateTime(task.deadline)}.\n\n${task.description ?? ""}`
      : `Част си от проект "${project.title}". След като задача "${prevTitle}" бъде изпълнена (одобрена), ще трябва да изпълниш "${task.title}" — срок ${delayText} от този момент.\n\n${task.description ?? ""}`;
    await dispatchToAllChannels(toNotificationTarget(task.assignee), { subject: `Проект: ${project.title}`, body: assigneeBody }, { taskId: task.id });

    if (task.owner) {
      const ownerBody = isFirst
        ? `Ти си Owner на стъпка "${task.title}" от проект "${project.title}" (изпълнител: ${task.assignee.name}) — срок ${formatDateTime(task.deadline)}.`
        : `Ти си Owner на стъпка "${task.title}" от проект "${project.title}" (изпълнител: ${task.assignee.name}). Ще стане активна след като "${prevTitle}" бъде изпълнена, със срок ${delayText} след това.`;
      await dispatchToAllChannels(toNotificationTarget(task.owner), { subject: `Проект: ${project.title}`, body: ownerBody }, { taskId: task.id });
    }
  }

  await broadcastToAdmins({
    subject: "Нов проект създаден",
    body: `"${project.title}" (от ${req.user!.email}) — ${createdTasks.length} стъпки: ${createdTasks.map((t) => `${t.assignee.name} ("${t.title}")`).join(" → ")}.`,
  });
  await logAction(
    req.user!.sub,
    "TASK_CREATED",
    "Task",
    createdTasks[0].id,
    `Създаден проект "${project.title}" (${createdTasks.length} стъпки: ${createdTasks.map((t) => t.assignee.name).join(" → ")})`
  );

  res.status(201).json({ project, steps: createdTasks });
});
