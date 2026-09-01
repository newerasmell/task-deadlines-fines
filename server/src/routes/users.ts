import { Router } from "express";
import { z } from "zod";
import { hashPassword } from "../lib/auth";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth, requireSuperAdmin } from "../middleware/auth";

export const usersRouter = Router();

usersRouter.use(requireAuth);

const publicUser = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  isSuperAdmin: true,
  canAssignTasks: true,
  phone: true,
  telegramChatId: true,
  slackMemberId: true,
  whatsappPhone: true,
  viberUserId: true,
  googleCalendarId: true,
  createdAt: true,
} as const;

// Admins see everyone. Everyone else gets just enough of the roster to
// build task forms with: themselves, every Admin (to pick as Owner for a
// self-assigned task), and — if they're a Lead — the employees in their
// assignment scope (who they're allowed to create tasks for).
usersRouter.get("/", async (req, res) => {
  if (req.user!.role === "ADMIN") {
    const users = await prisma.user.findMany({ select: publicUser, orderBy: { createdAt: "asc" } });
    return res.json(users);
  }

  const [self, admins, scope] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.user!.sub }, select: publicUser }),
    prisma.user.findMany({ where: { role: "ADMIN", active: true }, select: publicUser }),
    prisma.assignmentScope.findMany({
      where: { leadId: req.user!.sub },
      include: { employee: { select: publicUser } },
    }),
  ]);

  const byId = new Map<string, (typeof admins)[number]>();
  if (self) byId.set(self.id, self);
  for (const a of admins) byId.set(a.id, a);
  for (const s of scope) byId.set(s.employee.id, s.employee);

  res.json([...byId.values()]);
});

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(["ADMIN", "EMPLOYEE"]).default("EMPLOYEE"),
  isSuperAdmin: z.boolean().optional(),
  canAssignTasks: z.boolean().optional(),
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

  const { password, ...rest } = parsed.data;
  if (!req.user!.isSuperAdmin) {
    // Only a super admin may hand out ADMIN role, Lead permission, or super-admin status.
    rest.role = "EMPLOYEE";
    delete rest.isSuperAdmin;
    delete rest.canAssignTasks;
  }
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { ...rest, passwordHash },
    select: publicUser,
  });
  res.status(201).json(user);
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.enum(["ADMIN", "EMPLOYEE"]).optional(),
  active: z.boolean().optional(),
  isSuperAdmin: z.boolean().optional(),
  canAssignTasks: z.boolean().optional(),
  password: z.string().min(6).optional(),
  phone: z.string().nullable().optional(),
  telegramChatId: z.string().nullable().optional(),
  slackMemberId: z.string().nullable().optional(),
  whatsappPhone: z.string().nullable().optional(),
  viberUserId: z.string().nullable().optional(),
  googleCalendarId: z.string().nullable().optional(),
});

// Admins can edit anyone; employees can edit their own contact channels only.
// Role / isSuperAdmin / canAssignTasks can only be changed by a super admin,
// regardless of who's being edited (even a regular admin can't self-promote).
usersRouter.patch("/:id", async (req, res) => {
  const isSelf = req.user!.sub === req.params.id;
  if (req.user!.role !== "ADMIN" && !isSelf) {
    return res.status(403).json({ error: "Not allowed" });
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.email) {
    const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (existing && existing.id !== req.params.id) {
      return res.status(409).json({ error: "Email already registered" });
    }
  }

  const data: Record<string, unknown> = { ...parsed.data };
  if (req.user!.role !== "ADMIN") {
    // Employees may only touch their own notification identities, plus their own email/password.
    for (const key of ["name", "role", "active", "isSuperAdmin", "canAssignTasks"]) delete data[key];
  } else if (!req.user!.isSuperAdmin) {
    for (const key of ["role", "isSuperAdmin", "canAssignTasks"]) delete data[key];
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

// --- Assignment scope: which employees a Lead may create/assign tasks for ---

usersRouter.get("/:id/scope", requireAdmin, async (req, res) => {
  const scope = await prisma.assignmentScope.findMany({
    where: { leadId: req.params.id },
    select: { employeeId: true },
  });
  res.json(scope.map((s) => s.employeeId));
});

const scopeSchema = z.object({ employeeIds: z.array(z.string()) });

usersRouter.put("/:id/scope", requireSuperAdmin, async (req, res) => {
  const parsed = scopeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await prisma.$transaction([
    prisma.assignmentScope.deleteMany({ where: { leadId: req.params.id } }),
    prisma.assignmentScope.createMany({
      data: parsed.data.employeeIds.map((employeeId) => ({ leadId: req.params.id, employeeId })),
    }),
  ]);
  res.json({ ok: true });
});
