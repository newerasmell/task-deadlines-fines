import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireSuperAdmin } from "../middleware/auth";

// Everything here only ever stores or forwards ciphertext, salts and IVs —
// values that are meaningless without a master password that lives only
// in someone's head and, briefly, in their browser's memory. See the
// VaultTable/VaultUserKey comments in prisma/schema.prisma for the full
// crypto shape before changing anything in this file; nothing server-side
// should ever need to "understand" vault content, and if a change here
// starts to need that, something has gone wrong.
//
// Each table is its own encryption domain (own TK) — creating a table and
// managing its membership stays Ultimate-Admin-only (requireSuperAdmin),
// but reading/using a table's contents is gated purely by membership
// (requireTableMembership), which an Ultimate Admin does NOT automatically
// have just by virtue of the role.
export const vaultRouter = Router();

vaultRouter.use(requireAuth);

async function requireTableMembership(req: Request, res: Response, next: NextFunction) {
  const member = await prisma.vaultTableMember.findUnique({
    where: { tableId_userId: { tableId: req.params.tableId, userId: req.user!.sub } },
  });
  if (!member) return res.status(403).json({ error: "Нямаш достъп до тази таблица" });
  next();
}

vaultRouter.get("/my-key", async (req, res) => {
  const key = await prisma.vaultUserKey.findUnique({ where: { userId: req.user!.sub } });
  res.json(key ? { salt: key.salt, iterations: key.iterations } : null);
});

// Public key-derivation material for an arbitrary user (salt is not
// secret) — the granting admin's browser needs this to know whether the
// person being granted access already has a personal master password
// (reuse their salt) or needs to set a brand-new one (generate a salt).
vaultRouter.get("/users/:userId/key", requireSuperAdmin, async (req, res) => {
  const key = await prisma.vaultUserKey.findUnique({ where: { userId: req.params.userId } });
  res.json(key ? { salt: key.salt, iterations: key.iterations } : null);
});

const tableListInclude = {
  _count: { select: { members: true } },
} as const;

vaultRouter.get("/tables", async (req, res) => {
  const isSuperAdmin = !!req.user!.isSuperAdmin;
  const [tables, myMemberships] = await Promise.all([
    isSuperAdmin
      ? prisma.vaultTable.findMany({ include: tableListInclude, orderBy: { name: "asc" } })
      : prisma.vaultTable.findMany({
          where: { members: { some: { userId: req.user!.sub } } },
          include: tableListInclude,
          orderBy: { name: "asc" },
        }),
    prisma.vaultTableMember.findMany({ where: { userId: req.user!.sub } }),
  ]);
  const myWrapByTable = new Map(myMemberships.map((m) => [m.tableId, m]));

  res.json(
    tables.map((t) => {
      const mine = myWrapByTable.get(t.id);
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        memberCount: t._count.members,
        createdAt: t.createdAt,
        isMember: !!mine,
        myWrap: mine ? { wrappedKey: mine.wrappedKey, wrappedKeyIv: mine.wrappedKeyIv } : null,
      };
    })
  );
});

const createTableSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  wrappedKey: z.string().min(1),
  wrappedKeyIv: z.string().min(1),
  salt: z.string().min(1).optional(),
  iterations: z.number().int().positive().optional(),
});

// The creating admin generated a brand-new random TK client-side and
// wrapped it under their own stretched key — this persists the table and
// that first membership row together. If this admin has never belonged to
// any vault table before, `salt`/`iterations` are required (their very
// first VaultUserKey); otherwise they're ignored and the existing salt is
// reused, so their one master password keeps working everywhere.
vaultRouter.post("/tables", requireSuperAdmin, async (req, res) => {
  const parsed = createTableSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existingKey = await prisma.vaultUserKey.findUnique({ where: { userId: req.user!.sub } });
  if (!existingKey && (!parsed.data.salt || !parsed.data.iterations)) {
    return res.status(400).json({ error: "Липсва salt/iterations за нов master key" });
  }

  const table = await prisma.$transaction(async (tx) => {
    if (!existingKey) {
      await tx.vaultUserKey.create({
        data: { userId: req.user!.sub, salt: parsed.data.salt!, iterations: parsed.data.iterations! },
      });
    }
    const created = await tx.vaultTable.create({
      data: { name: parsed.data.name, description: parsed.data.description, createdById: req.user!.sub },
    });
    await tx.vaultTableMember.create({
      data: {
        tableId: created.id,
        userId: req.user!.sub,
        wrappedKey: parsed.data.wrappedKey,
        wrappedKeyIv: parsed.data.wrappedKeyIv,
        grantedById: req.user!.sub,
      },
    });
    return created;
  });

  res.status(201).json({ id: table.id, name: table.name, description: table.description });
});

const memberInclude = {
  user: { select: { id: true, name: true, email: true, isSuperAdmin: true } },
  grantedBy: { select: { id: true, name: true, email: true } },
} as const;

vaultRouter.get("/tables/:tableId/members", requireSuperAdmin, async (req, res) => {
  const members = await prisma.vaultTableMember.findMany({
    where: { tableId: req.params.tableId },
    include: memberInclude,
    orderBy: { createdAt: "asc" },
  });
  res.json(
    members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      isSuperAdmin: m.user.isSuperAdmin,
      grantedByName: m.grantedBy?.name ?? null,
      createdAt: m.createdAt,
    }))
  );
});

const grantMemberSchema = z.object({
  userId: z.string().min(1),
  wrappedKey: z.string().min(1),
  wrappedKeyIv: z.string().min(1),
  salt: z.string().min(1).optional(),
  iterations: z.number().int().positive().optional(),
});

// Called by an admin who currently has this table's TK unlocked in their
// own browser, right after the new member typed their master password
// (existing or brand-new) into that same session so it could be wrapped
// for them. requireTableMembership below (not just requireSuperAdmin)
// ensures the caller actually has TK to wrap in the first place.
vaultRouter.post(
  "/tables/:tableId/members",
  requireSuperAdmin,
  requireTableMembership,
  async (req, res) => {
    const parsed = grantMemberSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (!target || !target.active) return res.status(400).json({ error: "Получателят трябва да е активен служител" });

    const existing = await prisma.vaultTableMember.findUnique({
      where: { tableId_userId: { tableId: req.params.tableId, userId: parsed.data.userId } },
    });
    if (existing) return res.status(409).json({ error: "Този човек вече има достъп до тази таблица" });

    const existingKey = await prisma.vaultUserKey.findUnique({ where: { userId: parsed.data.userId } });
    if (!existingKey && (!parsed.data.salt || !parsed.data.iterations)) {
      return res.status(400).json({ error: "Липсва salt/iterations за нов master key" });
    }

    await prisma.$transaction(async (tx) => {
      if (!existingKey) {
        await tx.vaultUserKey.create({
          data: { userId: parsed.data.userId, salt: parsed.data.salt!, iterations: parsed.data.iterations! },
        });
      }
      await tx.vaultTableMember.create({
        data: {
          tableId: req.params.tableId,
          userId: parsed.data.userId,
          wrappedKey: parsed.data.wrappedKey,
          wrappedKeyIv: parsed.data.wrappedKeyIv,
          grantedById: req.user!.sub,
        },
      });
    });

    res.status(201).json({ ok: true });
  }
);

vaultRouter.delete("/tables/:tableId/members/:userId", requireSuperAdmin, async (req, res) => {
  const total = await prisma.vaultTableMember.count({ where: { tableId: req.params.tableId } });
  if (total <= 1) {
    return res.status(400).json({ error: "Не може да се премахне последният достъп — таблицата ще стане недостъпна завинаги" });
  }
  try {
    await prisma.vaultTableMember.delete({
      where: { tableId_userId: { tableId: req.params.tableId, userId: req.params.userId } },
    });
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
  res.status(204).send();
});

const entryInclude = {
  createdBy: { select: { id: true, name: true, email: true } },
} as const;

vaultRouter.get("/tables/:tableId/entries", requireTableMembership, async (req, res) => {
  const entries = await prisma.vaultEntry.findMany({
    where: { tableId: req.params.tableId, deletedAt: null },
    include: entryInclude,
    orderBy: { createdAt: "desc" },
  });
  res.json(entries);
});

const entrySchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
});

vaultRouter.post("/tables/:tableId/entries", requireTableMembership, async (req, res) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const entry = await prisma.$transaction(async (tx) => {
    const created = await tx.vaultEntry.create({
      data: { tableId: req.params.tableId, ...parsed.data, createdById: req.user!.sub },
      include: entryInclude,
    });
    await tx.vaultEntryHistory.create({
      data: { tableId: req.params.tableId, entryId: created.id, action: "CREATED", actorId: req.user!.sub },
    });
    return created;
  });
  res.status(201).json(entry);
});

vaultRouter.patch("/tables/:tableId/entries/:entryId", requireTableMembership, async (req, res) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.vaultEntry.findFirst({
    where: { id: req.params.entryId, tableId: req.params.tableId, deletedAt: null },
  });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const entry = await prisma.$transaction(async (tx) => {
    const updated = await tx.vaultEntry.update({
      where: { id: req.params.entryId },
      data: parsed.data,
      include: entryInclude,
    });
    await tx.vaultEntryHistory.create({
      data: { tableId: req.params.tableId, entryId: updated.id, action: "UPDATED", actorId: req.user!.sub },
    });
    return updated;
  });
  res.json(entry);
});

vaultRouter.delete("/tables/:tableId/entries/:entryId", requireTableMembership, async (req, res) => {
  const existing = await prisma.vaultEntry.findFirst({
    where: { id: req.params.entryId, tableId: req.params.tableId, deletedAt: null },
  });
  if (!existing) return res.status(404).json({ error: "Not found" });

  await prisma.$transaction(async (tx) => {
    await tx.vaultEntry.update({ where: { id: req.params.entryId }, data: { deletedAt: new Date() } });
    await tx.vaultEntryHistory.create({
      data: { tableId: req.params.tableId, entryId: req.params.entryId, action: "DELETED", actorId: req.user!.sub },
    });
  });
  res.status(204).send();
});

// Metadata-only — see the VaultEntryHistory comment in schema.prisma. The
// client decrypts each referenced entry's (still-surviving, possibly
// soft-deleted) ciphertext to label each row with a title; the server
// never does that itself.
vaultRouter.get("/tables/:tableId/history", requireTableMembership, async (req, res) => {
  const rows = await prisma.vaultEntryHistory.findMany({
    where: { tableId: req.params.tableId },
    include: {
      actor: { select: { id: true, name: true } },
      entry: { select: { id: true, ciphertext: true, iv: true, deletedAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  res.json(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorName: r.actor.name,
      createdAt: r.createdAt,
      entry: { id: r.entry.id, ciphertext: r.entry.ciphertext, iv: r.entry.iv, deleted: !!r.entry.deletedAt },
    }))
  );
});
