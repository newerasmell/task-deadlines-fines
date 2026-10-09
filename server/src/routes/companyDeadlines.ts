import { Router } from "express";
import { z } from "zod";
import { formatDateTime } from "../lib/dateFormat";
import { prisma } from "../lib/prisma";
import { requireAuth, requireSuperAdmin } from "../middleware/auth";
import { dispatchRespectingBusinessHours, toNotificationTarget } from "../notifications/dispatcher";

export const companyDeadlinesRouter = Router();

// Whole page is super-admin-only, both to view and to manage — this tracks
// filing/payment obligations across the entire corporate group, and its
// reminders are restricted to "мастър акаунтите" the same way (see
// companyDeadlineScanner.ts), so there's no point exposing it to anyone the
// reminders wouldn't also reach.
companyDeadlinesRouter.use(requireAuth, requireSuperAdmin);

const include = {
  createdBy: { select: { id: true, name: true, email: true } },
} as const;

companyDeadlinesRouter.get("/", async (_req, res) => {
  const items = await prisma.companyDeadline.findMany({
    include,
    orderBy: { dueDate: "asc" },
  });
  res.json(items);
});

const recurrenceEnum = z.enum(["NONE", "YEARLY", "QUARTERLY", "MONTHLY"]);

const createSchema = z.object({
  company: z.string().min(1),
  jurisdiction: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  dueDate: z.coerce.date(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  recurrence: recurrenceEnum.optional(),
});

companyDeadlinesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const item = await prisma.companyDeadline.create({
    data: { ...parsed.data, createdById: req.user!.sub },
    include,
  });

  await notifyMasterAccounts(
    `Нов фирмен срок: ${item.title}`,
    `${item.company} (${item.jurisdiction})\nКраен срок: ${formatDateTime(item.dueDate)}${item.amount ? `\nСума: ${item.amount} ${item.currency ?? "EUR"}` : ""}${item.description ? `\n\n${item.description}` : ""}`
  );

  res.status(201).json(item);
});

const updateSchema = z.object({
  company: z.string().min(1).optional(),
  jurisdiction: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  dueDate: z.coerce.date().optional(),
  amount: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  recurrence: recurrenceEnum.optional(),
  status: z.enum(["ACTIVE", "DONE", "CANCELLED"]).optional(),
});

function nextDueDate(current: Date, recurrence: string): Date {
  const next = new Date(current);
  if (recurrence === "YEARLY") next.setFullYear(next.getFullYear() + 1);
  else if (recurrence === "QUARTERLY") next.setMonth(next.getMonth() + 3);
  else next.setMonth(next.getMonth() + 1); // MONTHLY
  return next;
}

companyDeadlinesRouter.patch("/:id", async (req, res) => {
  const existing = await prisma.companyDeadline.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };

  // A new due date starts a fresh reminder cycle, same reasoning as
  // Subscription — the old tiers already fired for the old date.
  if (data.dueDate instanceof Date && data.dueDate.getTime() !== existing.dueDate.getTime()) {
    data.reminder30dSentAt = null;
    data.reminder15dSentAt = null;
    data.lastDailyReminderAt = null;
    data.lastPeriodicReminderAt = null;
  }

  const item = await prisma.companyDeadline.update({ where: { id: req.params.id }, data, include });

  // Marking a recurring obligation DONE closes out this occurrence but
  // immediately opens the next one — these come back every cycle on their
  // own, so "done" shouldn't mean "no longer tracked".
  if (parsed.data.status === "DONE" && existing.status !== "DONE" && existing.recurrence !== "NONE") {
    const next = await prisma.companyDeadline.create({
      data: {
        company: item.company,
        jurisdiction: item.jurisdiction,
        title: item.title,
        description: item.description,
        dueDate: nextDueDate(item.dueDate, item.recurrence),
        amount: item.amount,
        currency: item.currency,
        recurrence: item.recurrence,
        status: "ACTIVE",
        createdById: item.createdById,
      },
      include,
    });
    await notifyMasterAccounts(
      `Следващ цикъл: ${next.title}`,
      `${next.company} (${next.jurisdiction})\n"${next.title}" беше отбелязан като изпълнен — следващият краен срок е ${formatDateTime(next.dueDate)}.`
    );
    return res.json(item);
  }

  res.json(item);
});

companyDeadlinesRouter.delete("/:id", async (req, res) => {
  try {
    await prisma.companyDeadline.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

export async function notifyMasterAccounts(subject: string, body: string): Promise<void> {
  const masters = await prisma.user.findMany({ where: { isSuperAdmin: true, active: true } });
  for (const master of masters) {
    await dispatchRespectingBusinessHours(toNotificationTarget(master), { subject, body });
  }
}
