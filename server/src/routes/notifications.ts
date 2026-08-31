import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { dispatchToAllChannels, getAdapters, toNotificationTarget } from "../notifications/dispatcher";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

// Which channels are configured server-side (env vars set), independent of any one user's identities.
notificationsRouter.get("/channels", requireAdmin, async (_req, res) => {
  const channels = getAdapters().map((a) => ({ channel: a.channel, configured: a.isConfigured() }));
  res.json(channels);
});

notificationsRouter.get("/logs", requireAdmin, async (req, res) => {
  const userFilter = typeof req.query.userId === "string" ? req.query.userId : undefined;
  const logs = await prisma.notificationLog.findMany({
    where: userFilter ? { userId: userFilter } : {},
    include: { user: { select: { id: true, name: true } }, task: { select: { id: true, title: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(logs);
});

const testSendSchema = z.object({
  userId: z.string().min(1),
});

// Lets an admin verify a specific employee's channels are wired up correctly.
notificationsRouter.post("/test-send", requireAdmin, async (req, res) => {
  const parsed = testSendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!user) return res.status(404).json({ error: "User not found" });

  const results = await dispatchToAllChannels(toNotificationTarget(user), {
    subject: "Тестово известие",
    body: `Здравей, ${user.name}! Това е тестово съобщение от системата за срокове и глоби.`,
    deadline: new Date(Date.now() + 60 * 60 * 1000),
  });

  res.json({ results });
});
