import { NextFunction, Request, Response, Router } from "express";
import fs from "fs";
import { z } from "zod";
import { logAction } from "../lib/auditLog";
import { verifyToken } from "../lib/auth";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { absoluteUploadPath, uploadAttachments } from "../lib/uploads";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

export const tasksRouter = Router();

const taskInclude = {
  assignee: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true, isSuperAdmin: true } },
  owner: { select: { id: true, name: true, email: true } },
  fines: true,
} as const;

// A regular Admin may assign, review and see every task, but may not edit or
// delete one that a super admin (Ultimate Admin) set up — only the super
// admin, or the person actually doing the work, can touch it.
function isLockedFromAdmin(task: { createdBy: { isSuperAdmin: boolean } }, actorIsSuperAdmin: boolean) {
  return task.createdBy.isSuperAdmin && !actorIsSuperAdmin;
}

// What a task's assignee/owner relation is allowed to carry back to the
// client — enough for the UI and for toNotificationTarget(), never the
// password hash.
const notifiableUserSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  telegramChatId: true,
  slackMemberId: true,
  whatsappPhone: true,
  viberUserId: true,
  googleCalendarId: true,
} as const;

function visibleToUser(
  task: { assigneeId: string; ownerId: string | null; createdById: string },
  userId: string,
  isAdmin: boolean
) {
  return isAdmin || task.assigneeId === userId || task.ownerId === userId || task.createdById === userId;
}

// Accepts a Bearer header (normal API calls) OR a `?token=` query param, since
// an <img src> tag can't set request headers — used only for the attachment
// download route below, which is registered before the router-wide requireAuth.
function requireAuthViaHeaderOrQuery(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : (req.query.token as string | undefined);
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

tasksRouter.get(
  "/:id/submissions/:submissionId/attachments/:attachmentId",
  requireAuthViaHeaderOrQuery,
  async (req, res) => {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: "Not found" });
    if (!visibleToUser(task, req.user!.sub, req.user!.role === "ADMIN")) {
      return res.status(403).json({ error: "Not allowed" });
    }
    const attachment = await prisma.attachment.findUnique({ where: { id: req.params.attachmentId } });
    if (!attachment || attachment.submissionId !== req.params.submissionId) {
      return res.status(404).json({ error: "Not found" });
    }
    const filePath = absoluteUploadPath(attachment.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing" });

    res.setHeader("Content-Type", attachment.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(attachment.originalName)}"`);
    fs.createReadStream(filePath).pipe(res);
  }
);

tasksRouter.use(requireAuth);

tasksRouter.get("/", async (req, res) => {
  const isAdmin = req.user!.role === "ADMIN";
  const assigneeFilter = typeof req.query.assigneeId === "string" ? req.query.assigneeId : undefined;

  const tasks = await prisma.task.findMany({
    where: {
      deletedAt: null,
      ...(isAdmin
        ? assigneeFilter
          ? { assigneeId: assigneeFilter }
          : {}
        : { OR: [{ assigneeId: req.user!.sub }, { ownerId: req.user!.sub }, { createdById: req.user!.sub }] }),
    },
    include: taskInclude,
    orderBy: { deadline: "asc" },
  });
  res.json(tasks);
});

tasksRouter.get("/:id", async (req, res) => {
  const task = await prisma.task.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: {
      ...taskInclude,
      notificationLogs: { orderBy: { createdAt: "desc" }, take: 20 },
      submissions: {
        orderBy: { createdAt: "desc" },
        include: {
          submittedBy: { select: { id: true, name: true } },
          reviewedBy: { select: { id: true, name: true } },
          attachments: true,
        },
      },
    },
  });
  if (!task) return res.status(404).json({ error: "Not found" });
  if (!visibleToUser(task, req.user!.sub, req.user!.role === "ADMIN")) {
    return res.status(403).json({ error: "Not allowed" });
  }
  res.json(task);
});

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeId: z.string().min(1),
  ownerId: z.string().min(1).optional(),
  deadline: z.coerce.date(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
});

tasksRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
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
    // Leads can hand tasks to one another freely; scope only gates regular employees.
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
    // Nobody reviews their own work: a self-assigned task must be watched by an Admin.
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

  const task = await prisma.task.create({
    data: { ...parsed.data, createdById: req.user!.sub },
    include: { assignee: { select: notifiableUserSelect }, owner: { select: notifiableUserSelect } },
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
  if (task.owner) {
    await dispatchToAllChannels(
      toNotificationTarget(task.owner),
      {
        subject: `Назначен си като преглеждащ: ${task.title}`,
        body: `Ти си Owner (преглеждащ) на задача "${task.title}" (изпълнител: ${assignee.name}, срок ${task.deadline.toLocaleString("bg-BG")}). Ще трябва да прегледаш работата, след като бъде подадена.`,
        deadline: task.deadline,
      },
      { taskId: task.id }
    );
  }
  await broadcastToAdmins({
    subject: "Нова задача създадена",
    body: `"${task.title}" → ${assignee.name}, срок ${task.deadline.toLocaleString("bg-BG")}.`,
  });
  await logAction(req.user!.sub, "TASK_CREATED", "Task", task.id, `Създадена задача "${task.title}" → ${assignee.name}`);

  res.status(201).json(task);
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  assigneeId: z.string().min(1).optional(),
  ownerId: z.string().nullable().optional(),
  deadline: z.coerce.date().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  status: z.enum(["PENDING", "IN_PROGRESS", "DONE", "OVERDUE", "CANCELLED"]).optional(),
});

tasksRouter.patch("/:id", async (req, res) => {
  const existing = await prisma.task.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: { createdBy: { select: { isSuperAdmin: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const isAdmin = req.user!.role === "ADMIN";
  const isAssignee = existing.assigneeId === req.user!.sub;
  if (!isAdmin && !isAssignee) return res.status(403).json({ error: "Not allowed" });

  // A regular Admin can't edit a task the Ultimate Admin set up, at all — not
  // even if they happen to be its assignee, that just downgrades them to the
  // employee-style status-only update below instead of a hard 403.
  const locked = isLockedFromAdmin(existing, req.user!.isSuperAdmin);
  if (locked && !isAssignee) {
    return res.status(403).json({ error: "Само Ultimate Admin може да редактира тази задача" });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };
  if (!isAdmin || locked) {
    // Employees (and a locked Admin acting only as assignee) can only start
    // work; completion goes through /submit for owner review.
    for (const key of ["title", "description", "assigneeId", "ownerId", "deadline", "priority"]) delete data[key];
    if (parsed.data.status && parsed.data.status !== "IN_PROGRESS") {
      return res.status(400).json({ error: "Use POST /tasks/:id/submit to complete a task" });
    }
  }
  if (parsed.data.status === "DONE" && existing.status !== "DONE") {
    data.completedAt = new Date();
  }

  const task = await prisma.task.update({ where: { id: req.params.id }, data });

  if (isAdmin && !locked && data.ownerId && data.ownerId !== existing.ownerId) {
    const newOwner = await prisma.user.findUnique({ where: { id: data.ownerId as string } });
    const assignee = await prisma.user.findUnique({ where: { id: task.assigneeId } });
    if (newOwner && assignee) {
      await dispatchToAllChannels(
        toNotificationTarget(newOwner),
        {
          subject: `Назначен си като преглеждащ: ${task.title}`,
          body: `Ти си Owner (преглеждащ) на задача "${task.title}" (изпълнител: ${assignee.name}, срок ${task.deadline.toLocaleString("bg-BG")}). Ще трябва да прегледаш работата, след като бъде подадена.`,
          deadline: task.deadline,
        },
        { taskId: task.id }
      );
    }
  }

  if (isAdmin && !locked) {
    const changed = Object.fromEntries(
      Object.entries(parsed.data).filter(([key, value]) => value !== undefined && (existing as Record<string, unknown>)[key] !== value)
    );
    if (Object.keys(changed).length > 0) {
      await logAction(
        req.user!.sub,
        "TASK_UPDATED",
        "Task",
        task.id,
        `Редактирана задача "${task.title}" (${Object.keys(changed).join(", ")})`,
        { before: Object.fromEntries(Object.keys(changed).map((k) => [k, (existing as Record<string, unknown>)[k]])), after: changed }
      );
    }
  }

  res.json(task);
});

tasksRouter.delete("/:id", requireAdmin, async (req, res) => {
  const existing = await prisma.task.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: { createdBy: { select: { isSuperAdmin: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Not found" });

  if (isLockedFromAdmin(existing, req.user!.isSuperAdmin)) {
    return res.status(403).json({ error: "Само Ultimate Admin може да изтрие тази задача" });
  }

  await prisma.task.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
  await logAction(req.user!.sub, "TASK_DELETED", "Task", existing.id, `Изтрита задача "${existing.title}"`, existing);
  await broadcastToAdmins({
    subject: "Задача изтрита",
    body: `"${existing.title}" изтрита от ${req.user!.email}.`,
  });

  res.status(204).send();
});

// --- Submit for review ---

tasksRouter.post("/:id/submit", uploadAttachments.array("attachments", 5), async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: { owner: true, assignee: true } });
  if (!task) return res.status(404).json({ error: "Not found" });
  if (task.assigneeId !== req.user!.sub) {
    return res.status(403).json({ error: "Only the assignee can submit this task" });
  }
  if (task.status === "DONE" || task.status === "CANCELLED") {
    return res.status(400).json({ error: `Task is already ${task.status}` });
  }

  const note = typeof req.body.note === "string" ? req.body.note : undefined;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

  const reviewDueAt = new Date(Date.now() + env.reviewDueHours * 60 * 60 * 1000);

  const submission = await prisma.taskSubmission.create({
    data: {
      taskId: task.id,
      submittedById: req.user!.sub,
      note,
      reviewDueAt: task.ownerId ? reviewDueAt : null,
      attachments: {
        create: files.map((f) => ({
          filename: f.filename,
          originalName: f.originalname,
          mimeType: f.mimetype,
          size: f.size,
        })),
      },
    },
    include: { attachments: true },
  });

  await prisma.task.update({ where: { id: task.id }, data: { status: "PENDING_REVIEW" } });

  const noteText = note ? `\n\nБележка: ${note}` : "";
  const attachmentsText = files.length > 0 ? `\nПриложени файлове: ${files.length}` : "";

  if (task.owner) {
    await dispatchToAllChannels(toNotificationTarget(task.owner), {
      subject: `За преглед: ${task.title}`,
      body: `${task.assignee.name} подаде задачата за твой преглед.${noteText}${attachmentsText}`,
    });
  }
  await broadcastToAdmins({
    subject: "Задача подадена за преглед",
    body: `"${task.title}" от ${task.assignee.name}${task.owner ? ` → преглежда ${task.owner.name}` : " (без зададен owner — admin преглежда)"}.${noteText}`,
  });

  res.status(201).json(submission);
});

// --- Review: approve / reject ---

function canReview(task: { ownerId: string | null }, userId: string, isAdmin: boolean) {
  return isAdmin || task.ownerId === userId;
}

tasksRouter.post("/:id/submissions/:submissionId/approve", uploadAttachments.array("attachments", 5), async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: { assignee: true } });
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!canReview(task, req.user!.sub, req.user!.role === "ADMIN")) {
    return res.status(403).json({ error: "Only the task owner or an admin can review this submission" });
  }
  const submission = await prisma.taskSubmission.findUnique({ where: { id: req.params.submissionId } });
  if (!submission || submission.taskId !== task.id) return res.status(404).json({ error: "Submission not found" });
  if (submission.reviewStatus !== "PENDING") return res.status(400).json({ error: "Already reviewed" });

  const reviewNote = typeof req.body?.reviewNote === "string" && req.body.reviewNote ? req.body.reviewNote : undefined;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const now = new Date();

  await prisma.taskSubmission.update({
    where: { id: submission.id },
    data: {
      reviewStatus: "APPROVED",
      reviewedById: req.user!.sub,
      reviewedAt: now,
      reviewNote,
      attachments: { create: files.map((f) => ({ kind: "REVIEW", filename: f.filename, originalName: f.originalname, mimeType: f.mimetype, size: f.size })) },
    },
  });
  await prisma.task.update({ where: { id: task.id }, data: { status: "DONE", completedAt: now } });

  await dispatchToAllChannels(toNotificationTarget(task.assignee), {
    subject: `Одобрена задача: ${task.title}`,
    body: `Твоята работа по "${task.title}" беше одобрена.${reviewNote ? `\n${reviewNote}` : ""}`,
  });
  await broadcastToAdmins({
    subject: "Задача одобрена",
    body: `"${task.title}" (${task.assignee.name}) е одобрена от ${req.user!.email}.`,
  });

  res.json({ ok: true });
});

const rejectSchema = z.object({ reviewNote: z.string().min(1) });

tasksRouter.post("/:id/submissions/:submissionId/reject", uploadAttachments.array("attachments", 5), async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: { assignee: true } });
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!canReview(task, req.user!.sub, req.user!.role === "ADMIN")) {
    return res.status(403).json({ error: "Only the task owner or an admin can review this submission" });
  }
  const submission = await prisma.taskSubmission.findUnique({ where: { id: req.params.submissionId } });
  if (!submission || submission.taskId !== task.id) return res.status(404).json({ error: "Submission not found" });
  if (submission.reviewStatus !== "PENDING") return res.status(400).json({ error: "Already reviewed" });

  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

  const now = new Date();
  await prisma.taskSubmission.update({
    where: { id: submission.id },
    data: {
      reviewStatus: "REJECTED",
      reviewedById: req.user!.sub,
      reviewedAt: now,
      reviewNote: parsed.data.reviewNote,
      attachments: { create: files.map((f) => ({ kind: "REVIEW", filename: f.filename, originalName: f.originalname, mimeType: f.mimetype, size: f.size })) },
    },
  });
  const newStatus = now > task.deadline ? "OVERDUE" : "IN_PROGRESS";
  await prisma.task.update({ where: { id: task.id }, data: { status: newStatus } });

  await dispatchToAllChannels(toNotificationTarget(task.assignee), {
    subject: `Върната за доработка: ${task.title}`,
    body: `Подадената работа по "${task.title}" не беше одобрена.\nПричина: ${parsed.data.reviewNote}`,
  });
  await broadcastToAdmins({
    subject: "Задача отхвърлена при преглед",
    body: `"${task.title}" (${task.assignee.name}) отхвърлена от ${req.user!.email}: ${parsed.data.reviewNote}`,
  });

  res.json({ ok: true });
});
