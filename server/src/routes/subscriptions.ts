import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { formatDateTime } from "../lib/dateFormat";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

export const subscriptionsRouter = Router();

subscriptionsRouter.use(requireAuth);

// This whole page is opt-in per account (User.canAccessSubscriptions),
// granted only by a super admin — separate from being an Admin at all.
async function requireSubscriptionsAccess(req: Request, res: Response, next: NextFunction) {
  if (req.user!.isSuperAdmin) return next();
  const user = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: { canAccessSubscriptions: true } });
  if (!user?.canAccessSubscriptions) {
    return res.status(403).json({ error: "Нямаш достъп до тази страница" });
  }
  next();
}

subscriptionsRouter.use(requireSubscriptionsAccess);

const subscriptionInclude = {
  owner: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
} as const;

subscriptionsRouter.get("/", async (_req, res) => {
  const items = await prisma.subscription.findMany({
    include: subscriptionInclude,
    orderBy: { dueDate: "asc" },
  });
  res.json(items);
});

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  dueDate: z.coerce.date(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  ownerId: z.string().optional(),
});

// One-off notification on creation, to both the creator and the Owner (if
// different) — nothing further until the reminder tiers in
// subscriptionScanner.ts start firing as the due date approaches.
subscriptionsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let owner = null;
  if (parsed.data.ownerId) {
    owner = await prisma.user.findUnique({ where: { id: parsed.data.ownerId } });
    if (!owner) return res.status(400).json({ error: "Owner not found" });
  }

  const item = await prisma.subscription.create({
    data: { ...parsed.data, createdById: req.user!.sub },
    include: subscriptionInclude,
  });

  const creator = await prisma.user.findUnique({ where: { id: req.user!.sub } });
  const body = `Краен срок: ${formatDateTime(item.dueDate)}${item.amount ? `\nСума: ${item.amount} ${item.currency ?? "EUR"}` : ""}${item.description ? `\n\n${item.description}` : ""}`;

  if (creator) {
    await dispatchToAllChannels(toNotificationTarget(creator), {
      subject: `Създаден елемент за проследяване: ${item.title}`,
      body,
    });
  }
  if (owner && owner.id !== item.createdById) {
    await dispatchToAllChannels(toNotificationTarget(owner), {
      subject: `Ти си Owner на: ${item.title}`,
      body,
    });
  }

  res.status(201).json(item);
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  dueDate: z.coerce.date().optional(),
  amount: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  status: z.enum(["ACTIVE", "PAID", "CANCELLED"]).optional(),
});

subscriptionsRouter.patch("/:id", async (req, res) => {
  const existing = await prisma.subscription.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };

  // A new due date starts a fresh reminder cycle, same reasoning as a task
  // deadline edit — the old tiers already fired for the old date.
  if (data.dueDate instanceof Date && data.dueDate.getTime() !== existing.dueDate.getTime()) {
    data.reminder30dSentAt = null;
    data.reminder15dSentAt = null;
    data.lastDailyReminderAt = null;
    data.lastPeriodicReminderAt = null;
  }

  const item = await prisma.subscription.update({
    where: { id: req.params.id },
    data,
    include: subscriptionInclude,
  });
  res.json(item);
});

subscriptionsRouter.delete("/:id", async (req, res) => {
  try {
    await prisma.subscription.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});
