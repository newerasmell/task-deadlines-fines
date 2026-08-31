import { Router } from "express";
import { z } from "zod";
import { hashPassword } from "../lib/auth";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const usersRouter = Router();

usersRouter.use(requireAuth);

const publicUser = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  phone: true,
  telegramChatId: true,
  slackMemberId: true,
  whatsappPhone: true,
  viberUserId: true,
  googleCalendarId: true,
  createdAt: true,
} as const;

usersRouter.get("/", requireAdmin, async (_req, res) => {
  const users = await prisma.user.findMany({ select: publicUser, orderBy: { createdAt: "asc" } });
  res.json(users);
});

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(["ADMIN", "EMPLOYEE"]).default("EMPLOYEE"),
  phone: z.string().optional(),
  telegramChatId: z.string().optional(),
  slackMemberId: z.string().optional(),
  whatsappPhone: z.string().optional(),
  viberUserId: z.string().optional(),
  googleCalendarId: z.string().optional(),
});

usersRouter.post("/", requireAdmin, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const passwordHash = await hashPassword(parsed.data.password);
  const user = await prisma.user.create({
    data: { ...parsed.data, passwordHash },
    select: publicUser,
  });
  res.status(201).json(user);
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(["ADMIN", "EMPLOYEE"]).optional(),
  active: z.boolean().optional(),
  password: z.string().min(6).optional(),
  phone: z.string().nullable().optional(),
  telegramChatId: z.string().nullable().optional(),
  slackMemberId: z.string().nullable().optional(),
  whatsappPhone: z.string().nullable().optional(),
  viberUserId: z.string().nullable().optional(),
  googleCalendarId: z.string().nullable().optional(),
});

// Admins can edit anyone; employees can edit their own contact channels only.
usersRouter.patch("/:id", async (req, res) => {
  const isSelf = req.user!.sub === req.params.id;
  if (req.user!.role !== "ADMIN" && !isSelf) {
    return res.status(403).json({ error: "Not allowed" });
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };
  if (req.user!.role !== "ADMIN") {
    // Employees may only touch their own notification identities, nothing else.
    for (const key of ["name", "role", "active"]) delete data[key];
  }
  if (parsed.data.password) {
    data.passwordHash = await hashPassword(parsed.data.password);
    delete data.password;
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: publicUser,
    });
    res.json(user);
  } catch {
    res.status(404).json({ error: "User not found" });
  }
});

usersRouter.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.user.update({ where: { id: req.params.id }, data: { active: false } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "User not found" });
  }
});
