import { Router } from "express";
import { z } from "zod";
import { logAction } from "../lib/auditLog";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth, requireSuperAdmin } from "../middleware/auth";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

export const finesRouter = Router();

finesRouter.use(requireAuth);

finesRouter.get("/", async (req, res) => {
  const isAdmin = req.user!.role === "ADMIN";
  const userFilter = typeof req.query.userId === "string" ? req.query.userId : undefined;

  const fines = await prisma.fine.findMany({
    where: isAdmin
      ? userFilter
        ? { userId: userFilter }
        : {}
      : { OR: [{ userId: req.user!.sub }, { task: { ownerId: req.user!.sub } }] },
    include: {
      user: { select: { id: true, name: true, email: true } },
      task: { select: { id: true, title: true, deadline: true } },
      waivedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(fines);
});

finesRouter.get("/summary", requireAdmin, async (_req, res) => {
  const grouped = await prisma.fine.groupBy({
    by: ["userId", "status"],
    _sum: { amount: true },
    _count: true,
  });
  res.json(grouped);
});

const manualFineSchema = z.object({
  userId: z.string().min(1),
  taskId: z.string().optional(),
  amount: z.number().positive(),
  currency: z.string().default("EUR"),
  reason: z.string().min(1),
});

// Manual fine: for cases like unjustified absence/delay not tied to a specific task deadline.
finesRouter.post("/", requireAdmin, async (req, res) => {
  const parsed = manualFineSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!user) return res.status(400).json({ error: "User not found" });

  let task: { title: string } | null = null;
  if (parsed.data.taskId) {
    task = await prisma.task.findUnique({ where: { id: parsed.data.taskId }, select: { title: true } });
    if (!task) return res.status(400).json({ error: "Task not found" });
  }

  const fine = await prisma.fine.create({ data: parsed.data });

  await dispatchToAllChannels(toNotificationTarget(user), {
    subject: `Наложена глоба: ${fine.amount} ${fine.currency}`,
    body: `Причина: ${fine.reason}`,
  });
  await broadcastToAdmins({
    subject: "Ръчна глоба наложена",
    body: `${user.name}: ${fine.amount} ${fine.currency} — ${fine.reason} (от ${req.user!.email})`,
  });
  await logAction(
    req.user!.sub,
    "FINE_CREATED",
    "Fine",
    fine.id,
    `Наложена глоба на ${user.name}${task ? ` за задача "${task.title}"` : ""}: ${fine.amount} ${fine.currency}`,
    fine
  );

  res.status(201).json(fine);
});

const waiveSchema = z.object({
  reason: z.string().min(1),
});

// Waiving a fine is how an admin records that a delay WAS justified (illness, force majeure, etc.).
finesRouter.post("/:id/waive", requireAdmin, async (req, res) => {
  const parsed = waiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const fine = await prisma.fine.update({
      where: { id: req.params.id },
      data: {
        status: "WAIVED",
        waivedById: req.user!.sub,
        waivedReason: parsed.data.reason,
      },
      include: { user: true, task: { select: { title: true } } },
    });

    await dispatchToAllChannels(toNotificationTarget(fine.user), {
      subject: `Глобата е анулирана`,
      body: `Глоба от ${fine.amount} ${fine.currency} беше анулирана. Причина: ${parsed.data.reason}`,
    });
    await broadcastToAdmins({
      subject: "Глоба анулирана",
      body: `${fine.user.name}: ${fine.amount} ${fine.currency} анулирана от ${req.user!.email}. Причина: ${parsed.data.reason}`,
    });
    await logAction(
      req.user!.sub,
      "FINE_WAIVED",
      "Fine",
      fine.id,
      `Анулирана глоба на ${fine.user.name}${fine.task ? ` за задача "${fine.task.title}"` : ""}: ${fine.amount} ${fine.currency} — ${parsed.data.reason}`
    );

    res.json(fine);
  } catch {
    res.status(404).json({ error: "Fine not found" });
  }
});

const editAmountSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().min(1),
});

// Manually correcting what a specific fine actually charges — e.g. an
// escalation-day fine that was miscalculated — directly changes what
// someone owes, so it's restricted to the Ultimate Admin. A reason is
// mandatory so the correction is traceable in the audit log, same as
// waiving one.
finesRouter.patch("/:id/amount", requireSuperAdmin, async (req, res) => {
  const parsed = editAmountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.fine.findUnique({
    where: { id: req.params.id },
    include: { user: true, task: { select: { title: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Fine not found" });

  const fine = await prisma.fine.update({
    where: { id: req.params.id },
    data: { amount: parsed.data.amount },
    include: { user: true, task: { select: { title: true } } },
  });

  await logAction(
    req.user!.sub,
    "FINE_AMOUNT_EDITED",
    "Fine",
    fine.id,
    `Коригирана сума на глоба на ${fine.user.name}${fine.task ? ` за задача "${fine.task.title}"` : ""}: ${existing.amount} ${existing.currency} → ${fine.amount} ${fine.currency}. Причина: ${parsed.data.reason}`,
    { oldAmount: existing.amount, newAmount: fine.amount, reason: parsed.data.reason }
  );

  await dispatchToAllChannels(toNotificationTarget(fine.user), {
    subject: "Коригирана сума на глоба",
    body: `Сумата на глоба${fine.task ? ` за задача "${fine.task.title}"` : ""} беше коригирана от ${existing.amount} ${existing.currency} на ${fine.amount} ${fine.currency}.\nПричина: ${parsed.data.reason}`,
  });
  await broadcastToAdmins({
    subject: "Коригирана сума на глоба",
    body: `${fine.user.name}: ${existing.amount} ${existing.currency} → ${fine.amount} ${fine.currency} (от ${req.user!.email}). Причина: ${parsed.data.reason}`,
  });

  res.json(fine);
});

finesRouter.post("/:id/mark-paid", requireAdmin, async (req, res) => {
  try {
    const fine = await prisma.fine.update({ where: { id: req.params.id }, data: { status: "PAID" } });
    res.json(fine);
  } catch {
    res.status(404).json({ error: "Fine not found" });
  }
});

// One-time cleanup for the repeat-fine bug fixed alongside this route: before
// the fix, waiving a fine made the scanner treat that day as never-fined
// again, so it kept recreating an identical fine every scan cycle. This
// finds every group of fines sharing the same task+person+day-late+reason
// (the exact signature the bug produced) and waives every one in the group
// past the first — the earliest is left exactly as it was (still Active if
// nobody got to it, Paid/Waived if they did), so nothing about the real,
// original charge is touched. Restricted to the Ultimate Admin since it's a
// bulk write across other people's fines.
finesRouter.post("/cleanup-duplicates", requireSuperAdmin, async (req, res) => {
  const fines = await prisma.fine.findMany({
    where: { taskId: { not: null }, status: "ACTIVE" },
    include: { user: true, task: { select: { title: true } } },
    orderBy: { createdAt: "asc" },
  });

  const groups = new Map<string, typeof fines>();
  for (const fine of fines) {
    const key = `${fine.taskId}::${fine.userId}::${fine.daysLate}::${fine.reason}`;
    const group = groups.get(key) ?? [];
    group.push(fine);
    groups.set(key, group);
  }

  const waivedReason = "Дублирана глоба — отстранен бъг в глобовия механизъм (повторно начисляване след анулиране).";
  const waived: { id: string; userName: string; taskTitle: string | undefined; amount: number; currency: string }[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const dupe of group.slice(1)) {
      await prisma.fine.update({
        where: { id: dupe.id },
        data: { status: "WAIVED", waivedById: req.user!.sub, waivedReason },
      });
      waived.push({ id: dupe.id, userName: dupe.user.name, taskTitle: dupe.task?.title, amount: dupe.amount, currency: dupe.currency });
    }
  }

  if (waived.length > 0) {
    await logAction(
      req.user!.sub,
      "FINE_WAIVED",
      "Fine",
      "bulk-cleanup",
      `Автоматично изчистени ${waived.length} дублирани глоби (бъг в глобовия механизъм).`
    );
    await broadcastToAdmins({
      subject: "Изчистени дублирани глоби",
      body: `${req.user!.email} изчисти ${waived.length} дублирани глоби, породени от вече поправения бъг с повторното начисляване.`,
    });
  }

  res.json({ waivedCount: waived.length, waived });
});
