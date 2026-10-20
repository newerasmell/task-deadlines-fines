import { Router } from "express";
import { z } from "zod";
import { hashPassword, signToken, verifyPassword } from "../lib/auth";
import { acceptInvite, resolveInviteToken } from "../lib/invite";
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

// Public — the invited person has no account/session yet. Lets the
// accept-invite page show a friendly "invalid or expired" state instead
// of a blind password form that fails on submit.
authRouter.get("/invite/:token", async (req, res) => {
  const user = await resolveInviteToken(req.params.token);
  if (!user) return res.json({ valid: false });
  res.json({ valid: true, name: user.name, email: user.email });
});

const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(6),
});

// Public — sets the employee's own chosen password and, on success, logs
// them straight in (same token shape as /login) so they land on the
// dashboard immediately instead of being bounced to a login screen right
// after picking a password.
authRouter.post("/accept-invite", async (req, res) => {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const accepted = await acceptInvite(parsed.data.token, parsed.data.password);
  if (!accepted) return res.status(400).json({ error: "Invalid or expired invite" });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: accepted.id } });
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
