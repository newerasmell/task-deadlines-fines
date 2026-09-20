import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { activeAdminCount } from "../lib/admins";
import { logAudit } from "../lib/audit";
import { env } from "../lib/env";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";

export const authRouter = Router();

function toUserDto(user: { id: string; name: string; email: string; isUltimateAdmin: boolean }) {
  return { id: user.id, name: user.name, email: user.email, isUltimateAdmin: user.isUltimateAdmin };
}

// The dashboard used to be one shared password for everyone; it's now the
// one-time key to create the FIRST real login (see /setup below) — the
// setup route only ever works while the User table is still empty, so it
// stops mattering the moment a real account exists.
authRouter.get("/needs-setup", async (_req, res) => {
  const count = await prisma.user.count();
  res.json({ needsSetup: count === 0 });
});

const setupSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  dashboardPassword: z.string().min(1),
});

authRouter.post("/setup", async (req, res) => {
  const existing = await prisma.user.count();
  if (existing > 0) return res.status(400).json({ error: "Setup already completed — ask a teammate for an invite instead." });

  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.dashboardPassword.trim() !== env.dashboardPassword.trim()) {
    return res.status(401).json({ error: "Wrong dashboard password" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  // Whoever completes bootstrap is the first ultimate admin — someone has
  // to be, and this is the only account that could possibly exist yet.
  const user = await prisma.user.create({
    data: { name: parsed.data.name, email: parsed.data.email.toLowerCase().trim(), passwordHash, isUltimateAdmin: true },
  });
  await logAudit(user.id, "USER_CREATED", "User", user.id, `${user.name} set up the first account (ultimate admin)`);

  req.session.userId = user.id;
  res.status(201).json(toUserDto(user));
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Email and password required" });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase().trim() } });
  if (!user || !user.active) return res.status(401).json({ error: "Wrong email or password" });

  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Wrong email or password" });

  req.session.userId = user.id;
  res.json(toUserDto(user));
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

authRouter.get("/me", async (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false, user: null, needsAdminClaim: false });
  const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
  if (!user || !user.active) return res.json({ authenticated: false, user: null, needsAdminClaim: false });
  // Accounts created before the ultimate-admin role existed (or one whose
  // sole admin got deleted some other way) can end up with zero admins and
  // no in-app way to grant it, since /api/users is admin-only. Surface that
  // here so Settings can offer a one-time "claim ultimate admin" prompt —
  // see POST /claim-admin below.
  const needsAdminClaim = !user.isUltimateAdmin && (await activeAdminCount()) === 0;
  res.json({ authenticated: true, user: toUserDto(user), needsAdminClaim });
});

const claimAdminSchema = z.object({ dashboardPassword: z.string().min(1) });

// Same one-time-key idea as /setup, but for "accounts exist yet somehow
// none of them is an ultimate admin" instead of "no accounts exist yet".
// Only works while that's true — the moment any account is an admin, this
// stops applying and they'd need that admin to promote them instead.
authRouter.post("/claim-admin", requireAuth, async (req, res) => {
  const parsed = claimAdminSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dashboard password required" });

  if ((await activeAdminCount()) > 0) {
    return res.status(400).json({ error: "An ultimate admin already exists — ask them to promote you instead." });
  }
  if (parsed.data.dashboardPassword.trim() !== env.dashboardPassword.trim()) {
    return res.status(401).json({ error: "Wrong dashboard password" });
  }

  const user = await prisma.user.update({ where: { id: req.userId! }, data: { isUltimateAdmin: true } });
  await logAudit(user.id, "USER_UPDATED", "User", user.id, `${user.name} claimed ultimate admin (no admin existed)`);
  res.json(toUserDto(user));
});

const updateMeSchema = z.object({
  name: z.string().min(1).optional(),
  password: z.string().min(8).optional(),
});

// Self-service profile edit — every account (admin or not) can change
// their OWN name/password this way. Seeing or changing anyone ELSE's
// account goes through /api/users instead, which is ultimate-admin only.
authRouter.patch("/me", requireAuth, async (req, res) => {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = {};
  if (parsed.data.name) data.name = parsed.data.name;
  if (parsed.data.password) data.passwordHash = await bcrypt.hash(parsed.data.password, 10);

  const user = await prisma.user.update({ where: { id: req.userId! }, data });
  await logAudit(
    user.id,
    "USER_UPDATED",
    "User",
    user.id,
    `${user.name} updated their own account${parsed.data.password ? " (changed password)" : ""}`
  );
  res.json(toUserDto(user));
});
