import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

export const finesRouter = Router();

finesRouter.use(requireAuth);

finesRouter.get("/", async (req, res) => {
  const isAdmin = req.user!.role === "ADMIN";
  const userFilter = typeof req.query.userId === "string" ? req.query.userId : undefined;

  const fines = await prisma.fine.findMany({
    where: isAdmin ? (userFilter ? { userId: userFilter } : {}) : { userId: req.user!.sub },
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
  currency: z.string().default("BGN"),
  reason: z.string().min(1),
});

// Manual fine: for cases like unjustified absence/delay not tied to a specific task deadline.
finesRouter.post("/", requireAdmin, async (req, res) => {
  const parsed = manualFineSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!user) return res.status(400).json({ error: "User not found" });

  const fine = await prisma.fine.create({ data: parsed.data });

  await dispatchToAllChannels(toNotificationTarget(user), {
    subject: `Наложена глоба: ${fine.amount} ${fine.currency}`,
    body: `Причина: ${fine.reason}`,
  });

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
      include: { user: true },
    });

    await dispatchToAllChannels(toNotificationTarget(fine.user), {
      subject: `Глобата е анулирана`,
      body: `Глоба от ${fine.amount} ${fine.currency} беше анулирана. Причина: ${parsed.data.reason}`,
    });

    res.json(fine);
  } catch {
    res.status(404).json({ error: "Fine not found" });
  }
});

finesRouter.post("/:id/mark-paid", requireAdmin, async (req, res) => {
  try {
    const fine = await prisma.fine.update({ where: { id: req.params.id }, data: { status: "PAID" } });
    res.json(fine);
  } catch {
    res.status(404).json({ error: "Fine not found" });
  }
});
