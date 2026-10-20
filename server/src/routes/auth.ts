import { Router } from "express";
import { z } from "zod";
import { hashPassword, signToken, verifyPassword } from "../lib/auth";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signToken({ sub: user.id, role: user.role, email: user.email, isSuperAdmin: user.isSuperAdmin });
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isSuperAdmin: user.isSuperAdmin,
      canAssignTasks: user.canAssignTasks,
      canAccessSubscriptions: user.canAccessSubscriptions,
      // Same fields GET /auth/me returns — kept in sync so a just-logged-in
      // employee's Profile page shows correct link state without needing a
      // page reload to pick up a second /auth/me round trip.
      telegramChatId: user.telegramChatId,
      slackMemberId: user.slackMemberId,
    },
  });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isSuperAdmin: user.isSuperAdmin,
    canAssignTasks: user.canAssignTasks,
    canAccessSubscriptions: user.canAccessSubscriptions,
    // Surfaced so the self-service Profile page can show current link
    // state (and poll this endpoint while a Telegram link is in flight) —
    // both already existed on the row, just weren't returned here before.
    telegramChatId: user.telegramChatId,
    slackMemberId: user.slackMemberId,
  });
});

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(["ADMIN", "EMPLOYEE"]).default("EMPLOYEE"),
});

// Only an existing admin can create new accounts (bootstrap admin comes from the seed script).
authRouter.post("/register", requireAuth, requireAdmin, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { name, email, password, role } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "Email already registered" });
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role },
  });

  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
});
