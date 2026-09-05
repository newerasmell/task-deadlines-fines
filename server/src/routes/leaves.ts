import { Router } from "express";
import { z } from "zod";
import { formatDateOnly, formatDateTime } from "../lib/dateFormat";
import { logAction } from "../lib/auditLog";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";
import { OPEN_STATUSES } from "../jobs/deadlineScanner";

export const leavesRouter = Router();
export const rescheduleRequestsRouter = Router();

leavesRouter.use(requireAuth);
rescheduleRequestsRouter.use(requireAuth);

// Same rule as tasks.ts's canReview(): the task's Owner, or any Admin if it
// has none, decides what happens to a reschedule request against it.
function canDecide(task: { ownerId: string | null }, userId: string, isAdmin: boolean) {
  return isAdmin || task.ownerId === userId;
}

// A leave's start/end are calendar days, not real-world instants — always
// anchored to UTC so the stored range doesn't shift depending on the
// server's local timezone. parsed.data.startDate/endDate come from a plain
// "YYYY-MM-DD" string (an HTML date input), which z.coerce.date() parses
// as UTC midnight per the ECMAScript date-only-string rule, so reading it
// back with the UTC getters here recovers exactly the day that was typed.
function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}
function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

leavesRouter.get("/", async (req, res) => {
  const isAdmin = req.user!.role === "ADMIN";
  const userFilter = typeof req.query.userId === "string" ? req.query.userId : undefined;

  const leaves = await prisma.leave.findMany({
    where: isAdmin ? (userFilter ? { userId: userFilter } : {}) : { userId: req.user!.sub },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { startDate: "desc" },
  });
  res.json(leaves);
});

const createLeaveSchema = z.object({
  userId: z.string().min(1).optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  note: z.string().optional(),
});

// Blocking a day range for yourself (or, if you're an Admin, for someone
// else) has two automatic effects: the fine engine will exclude these days
// from that person's lateness from now on (deadlineScanner.ts), and any
// currently open task of theirs due inside the range gets a
// RescheduleRequest filed against it right here — never a silent deadline
// change, since that call belongs to the task's Owner (or an Admin).
leavesRouter.post("/", async (req, res) => {
  const parsed = createLeaveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const isAdmin = req.user!.role === "ADMIN";
  const targetUserId = isAdmin && parsed.data.userId ? parsed.data.userId : req.user!.sub;

  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) return res.status(400).json({ error: "User not found" });

  const startDate = startOfDay(parsed.data.startDate);
  const endDate = endOfDay(parsed.data.endDate);
  if (endDate < startDate) return res.status(400).json({ error: "Крайната дата трябва да е след началната." });

  const leave = await prisma.leave.create({
    data: { userId: targetUserId, startDate, endDate, note: parsed.data.note, createdById: req.user!.sub },
  });

  const leaveDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;

  const impacted = await prisma.task.findMany({
    where: {
      assigneeId: targetUserId,
      deletedAt: null,
      status: { in: OPEN_STATUSES as unknown as string[] },
      deadline: { gte: startDate, lte: endDate },
    },
    include: { owner: true, assignee: true },
  });

  const filed: { title: string; proposedDeadline: Date }[] = [];

  for (const task of impacted) {
    const proposedDeadline = new Date(task.deadline.getTime() + leaveDays * 24 * 60 * 60 * 1000);
    await prisma.rescheduleRequest.create({
      data: {
        taskId: task.id,
        leaveId: leave.id,
        requestedById: targetUserId,
        currentDeadline: task.deadline,
        proposedDeadline,
        note: `Автоматична заявка — отпуска ${formatDateOnly(startDate)} – ${formatDateOnly(endDate)}.`,
      },
    });
    filed.push({ title: task.title, proposedDeadline });

    if (task.owner) {
      await dispatchToAllChannels(toNotificationTarget(task.owner), {
        subject: `Заявка за нов срок: ${task.title}`,
        body: `${task.assignee.name} е в отпуск ${formatDateOnly(startDate)} – ${formatDateOnly(endDate)} и има засегната задача "${task.title}" (текущ срок ${formatDateTime(task.deadline)}). Предложен нов срок: ${formatDateTime(proposedDeadline)}. Одобри или отхвърли заявката в системата.`,
      });
    }
    await broadcastToAdmins({
      subject: "Заявка за нов срок (отпуска)",
      body: `${task.assignee.name} — "${task.title}" — текущ срок ${formatDateTime(task.deadline)}, предложен ${formatDateTime(proposedDeadline)} (отпуска ${formatDateOnly(startDate)} – ${formatDateOnly(endDate)}).`,
    });
  }

  if (filed.length > 0) {
    await dispatchToAllChannels(toNotificationTarget(target), {
      subject: "Отпуската ти засяга задачи",
      body: `Имаш ${filed.length} ${filed.length === 1 ? "задача, засегната" : "задачи, засегнати"} от отпуската ти ${formatDateOnly(startDate)} – ${formatDateOnly(endDate)}:\n${filed
        .map((f) => `• "${f.title}" → предложен нов срок ${formatDateTime(f.proposedDeadline)}`)
        .join("\n")}\nЗа всяка е изпратена заявка за нов срок до отговорника — изчакай одобрение.`,
    });
  }

  res.status(201).json({ ...leave, impactedTasksCount: impacted.length });
});

leavesRouter.delete("/:id", async (req, res) => {
  const leave = await prisma.leave.findUnique({ where: { id: req.params.id } });
  if (!leave) return res.status(404).json({ error: "Not found" });

  const isAdmin = req.user!.role === "ADMIN";
  if (!isAdmin && leave.userId !== req.user!.sub) {
    return res.status(403).json({ error: "Not allowed" });
  }

  await prisma.leave.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// --- Reschedule requests filed against a Leave ---

rescheduleRequestsRouter.get("/", async (req, res) => {
  const isAdmin = req.user!.role === "ADMIN";
  const requests = await prisma.rescheduleRequest.findMany({
    where: isAdmin ? {} : { OR: [{ requestedById: req.user!.sub }, { task: { ownerId: req.user!.sub } }] },
    include: {
      task: { select: { id: true, title: true, deadline: true, ownerId: true, owner: { select: { id: true, name: true } } } },
      requestedBy: { select: { id: true, name: true } },
      decidedBy: { select: { id: true, name: true } },
      leave: { select: { id: true, startDate: true, endDate: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(requests);
});

rescheduleRequestsRouter.post("/:id/approve", async (req, res) => {
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: req.params.id },
    include: { task: { include: { assignee: true } } },
  });
  if (!request) return res.status(404).json({ error: "Not found" });
  if (request.status !== "PENDING") return res.status(400).json({ error: "Already decided" });

  const isAdmin = req.user!.role === "ADMIN";
  if (!canDecide(request.task, req.user!.sub, isAdmin)) {
    return res.status(403).json({ error: "Only the task owner or an admin can decide this request" });
  }

  const now = new Date();

  // Same reset the manual deadline edit in PATCH /tasks/:id does — the old
  // reminder/escalation bookkeeping belongs to the old deadline.
  await prisma.task.update({
    where: { id: request.taskId },
    data: {
      deadline: request.proposedDeadline,
      reminder24hSentAt: null,
      reminder4hSentAt: null,
      lastPeriodicReminderAt: null,
      lastEscalationAt: null,
      lastFinedDaysLate: null,
      lastFinedAmount: null,
      ...(request.task.status === "OVERDUE" && request.proposedDeadline.getTime() > now.getTime() ? { status: "PENDING" } : {}),
    },
  });

  await prisma.rescheduleRequest.update({
    where: { id: request.id },
    data: { status: "APPROVED", decidedById: req.user!.sub, decidedAt: now },
  });

  await dispatchToAllChannels(toNotificationTarget(request.task.assignee), {
    subject: `Одобрен нов срок: ${request.task.title}`,
    body: `Новият срок за "${request.task.title}" е ${formatDateTime(request.proposedDeadline)}.`,
  });
  await logAction(
    req.user!.sub,
    "TASK_UPDATED",
    "Task",
    request.taskId,
    `Одобрена заявка за нов срок (отпуска) за "${request.task.title}": ${formatDateTime(request.currentDeadline)} → ${formatDateTime(request.proposedDeadline)}`
  );

  res.json({ ok: true });
});

const rejectSchema = z.object({ decisionNote: z.string().min(1) });

rescheduleRequestsRouter.post("/:id/reject", async (req, res) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: req.params.id },
    include: { task: { include: { assignee: true } } },
  });
  if (!request) return res.status(404).json({ error: "Not found" });
  if (request.status !== "PENDING") return res.status(400).json({ error: "Already decided" });

  const isAdmin = req.user!.role === "ADMIN";
  if (!canDecide(request.task, req.user!.sub, isAdmin)) {
    return res.status(403).json({ error: "Only the task owner or an admin can decide this request" });
  }

  await prisma.rescheduleRequest.update({
    where: { id: request.id },
    data: { status: "REJECTED", decidedById: req.user!.sub, decidedAt: new Date(), decisionNote: parsed.data.decisionNote },
  });

  await dispatchToAllChannels(toNotificationTarget(request.task.assignee), {
    subject: `Отхвърлена заявка за нов срок: ${request.task.title}`,
    body: `Заявката за нов срок на "${request.task.title}" беше отхвърлена. Причина: ${parsed.data.decisionNote}\nТекущият срок остава ${formatDateTime(request.currentDeadline)}.`,
  });

  res.json({ ok: true });
});
