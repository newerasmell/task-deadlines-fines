import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { logAudit } from "../lib/audit";
import { prisma } from "../lib/prisma";

// Mounted behind requireAuth + requireUltimateAdmin in app.ts — every route
// here is admin-only. Everyone else's self-service (own name/password) goes
// through PATCH /api/auth/me instead, which never exposes other users' rows.
export const usersRouter = Router();

function toUserDto(user: { id: string; name: string; email: string; active: boolean; isUltimateAdmin: boolean; createdAt: Date }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    active: user.active,
    isUltimateAdmin: user.isUltimateAdmin,
    createdAt: user.createdAt,
  };
}

async function activeAdminCount(): Promise<number> {
  return prisma.user.count({ where: { active: true, isUltimateAdmin: true } });
}

usersRouter.get("/", async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  res.json(users.map(toUserDto));
});

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  isUltimateAdmin: z.boolean().default(false),
});

usersRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const email = parsed.data.email.toLowerCase().trim();
  if (await prisma.user.findUnique({ where: { email } })) {
    return res.status(400).json({ error: "A user with this email already exists" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const user = await prisma.user.create({
    data: { name: parsed.data.name, email, passwordHash, isUltimateAdmin: parsed.data.isUltimateAdmin },
  });
  await logAudit(
    req.userId!,
    "USER_CREATED",
    "User",
    user.id,
    `Added teammate ${user.name} (${user.email})${user.isUltimateAdmin ? " as ultimate admin" : ""}`
  );
  res.status(201).json(toUserDto(user));
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  active: z.boolean().optional(),
  isUltimateAdmin: z.boolean().optional(),
});

usersRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "User not found" });

  const removingLastAdmin =
    existing.isUltimateAdmin &&
    existing.active &&
    ((parsed.data.isUltimateAdmin === false) || (parsed.data.active === false && parsed.data.isUltimateAdmin !== true));
  if (removingLastAdmin && (await activeAdminCount()) <= 1) {
    return res.status(400).json({ error: "Can't remove the last ultimate admin." });
  }

  if (parsed.data.active === false) {
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: "You can't deactivate your own account." });
    }
    const activeCount = await prisma.user.count({ where: { active: true } });
    if (activeCount <= 1) {
      return res.status(400).json({ error: "Can't deactivate the last active user." });
    }
  }

  const { password, email, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };
  if (email) data.email = email.toLowerCase().trim();
  if (password) data.passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.update({ where: { id: existing.id }, data });

  const changeDesc = [
    parsed.data.active === false ? "deactivated" : parsed.data.active === true ? "reactivated" : null,
    parsed.data.isUltimateAdmin === true ? "made ultimate admin" : parsed.data.isUltimateAdmin === false ? "removed ultimate admin" : null,
    password ? "reset password" : null,
    email && email.toLowerCase().trim() !== existing.email ? "changed email" : null,
    parsed.data.name && parsed.data.name !== existing.name ? "renamed" : null,
  ].filter(Boolean);
  await logAudit(
    req.userId!,
    "USER_UPDATED",
    "User",
    user.id,
    `Updated ${existing.name}${changeDesc.length ? ` (${changeDesc.join(", ")})` : ""}`
  );

  res.json(toUserDto(user));
});

usersRouter.delete("/:id", async (req, res) => {
  if (req.params.id === req.userId) {
    return res.status(400).json({ error: "You can't delete your own account." });
  }
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "User not found" });

  if (existing.isUltimateAdmin && existing.active && (await activeAdminCount()) <= 1) {
    return res.status(400).json({ error: "Can't remove the last ultimate admin." });
  }
  if (existing.active) {
    const activeCount = await prisma.user.count({ where: { active: true } });
    if (activeCount <= 1) return res.status(400).json({ error: "Can't delete the last active user." });
  }

  await prisma.user.delete({ where: { id: existing.id } });
  await logAudit(req.userId!, "USER_DELETED", "User", existing.id, `Removed teammate ${existing.name} (${existing.email})`);
  res.json({ ok: true });
});
