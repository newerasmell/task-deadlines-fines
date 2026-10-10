import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { logAction } from "../lib/auditLog";
import { prisma } from "../lib/prisma";
import { requireAuth, requireSuperAdmin } from "../middleware/auth";

// Everything here only ever stores or forwards ciphertext, salts and IVs —
// values that are meaningless without the master password that lives only
// in an admin's head and, briefly, in their browser's memory. See the
// VaultKeyWrap/VaultEntry comments in prisma/schema.prisma for the full
// crypto shape before changing anything in this file; nothing server-side
// should ever need to "understand" vault content, and if a change here
// starts to need that, something has gone wrong.
//
// Two tiers, not one: ANY active user can be granted a wrap and then use
// the vault (unlock with their own password, read/add/edit/delete
// entries) — vault access is no longer Ultimate-Admin-only. Managing WHO
// has access (granting a new wrap, revoking one) stays Ultimate-Admin-only
// regardless: a granted-but-not-super-admin user can use the vault but can
// never add or remove anyone else's access, including their own — see the
// requireSuperAdmin on /init, /grant and /grant/:userId below, applied
// per-route rather than router-wide.
export const vaultRouter = Router();

vaultRouter.use(requireAuth);

// A caller who has been granted a wrap — the actual gate on seeing or
// touching entries. Checked per-route rather than router-wide so /status,
// /init and /grant (which a not-yet-granted user must be able to reach,
// to see "ask X for access" or to bootstrap/grant) aren't blocked by it.
async function requireVaultAccess(req: Request, res: Response, next: NextFunction) {
  const wrap = await prisma.vaultKeyWrap.findUnique({ where: { userId: req.user!.sub } });
  if (!wrap) return res.status(403).json({ error: "Нямаш достъп до vault-а" });
  next();
}

const wrapInclude = {
  user: { select: { id: true, name: true, email: true, isSuperAdmin: true } },
  grantedBy: { select: { id: true, name: true, email: true } },
} as const;

vaultRouter.get("/status", async (req, res) => {
  const [myWrap, allWraps] = await Promise.all([
    prisma.vaultKeyWrap.findUnique({ where: { userId: req.user!.sub } }),
    prisma.vaultKeyWrap.findMany({ include: wrapInclude, orderBy: { createdAt: "asc" } }),
  ]);

  res.json({
    initialized: allWraps.length > 0,
    myWrap: myWrap
      ? { salt: myWrap.salt, wrappedKey: myWrap.wrappedKey, wrappedKeyIv: myWrap.wrappedKeyIv, iterations: myWrap.iterations }
      : null,
    // isSuperAdmin travels along so the frontend's "ask one of these
    // people" list (shown to someone with no wrap yet) can show only the
    // ones who can actually grant access — a regular granted user can use
    // the vault but has no way to add anyone, so listing them here would
    // just be a dead end.
    grantedTo: allWraps.map((w) => ({
      userId: w.userId,
      name: w.user.name,
      email: w.user.email,
      isSuperAdmin: w.user.isSuperAdmin,
      grantedByName: w.grantedBy?.name ?? null,
      createdAt: w.createdAt,
    })),
  });
});

const initSchema = z.object({
  salt: z.string().min(1),
  wrappedKey: z.string().min(1),
  wrappedKeyIv: z.string().min(1),
  iterations: z.number().int().positive(),
});

// First-ever setup: the admin doing this generated a brand-new random VK
// client-side and wrapped it under their own master password — this just
// persists that first wrap. Refused once ANY wrap already exists so a
// second admin can't accidentally start a second, disconnected vault
// (they need the "grant" flow below instead, from an admin who already
// has the real VK unlocked).
vaultRouter.post("/init", requireSuperAdmin, async (req, res) => {
  const existing = await prisma.vaultKeyWrap.count();
  if (existing > 0) return res.status(409).json({ error: "Vault already initialized" });

  const parsed = initSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const wrap = await prisma.vaultKeyWrap.create({
    data: { userId: req.user!.sub, grantedById: req.user!.sub, ...parsed.data },
  });
  await logAction(req.user!.sub, "VAULT_INITIALIZED", "VaultKeyWrap", wrap.id, `Vault инициализиран от ${req.user!.email}`);
  res.status(201).json({ ok: true });
});

const grantSchema = z.object({
  userId: z.string().min(1),
  salt: z.string().min(1),
  wrappedKey: z.string().min(1),
  wrappedKeyIv: z.string().min(1),
  iterations: z.number().int().positive(),
});

// Called by an Ultimate Admin who currently has VK unlocked in their own
// browser, right after the new person typed their own chosen master
// password into that same session so the caller's browser could wrap VK
// under it. The server can't verify any of that actually happened
// correctly — it just stores whatever wrap it's handed — the guard below
// (caller must already hold a wrap themselves) is an app-layer sanity
// check, not a crypto one; the crypto itself is what actually protects the
// data either way. Access can be granted to ANY active user, not just
// other Ultimate Admins — only granting/revoking stays admin-only (see
// requireSuperAdmin), not vault membership itself.
vaultRouter.post("/grant", requireSuperAdmin, async (req, res) => {
  const callerWrap = await prisma.vaultKeyWrap.findUnique({ where: { userId: req.user!.sub } });
  if (!callerWrap) return res.status(403).json({ error: "Нямаш достъп до vault-а, за да предоставиш достъп на друг" });

  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!target || !target.active) return res.status(400).json({ error: "Получателят трябва да е активен служител" });

  const existing = await prisma.vaultKeyWrap.findUnique({ where: { userId: parsed.data.userId } });
  if (existing) return res.status(409).json({ error: "Този човек вече има достъп" });

  const { userId, ...rest } = parsed.data;
  const wrap = await prisma.vaultKeyWrap.create({
    data: { userId, grantedById: req.user!.sub, ...rest },
  });
  await logAction(
    req.user!.sub,
    "VAULT_ACCESS_GRANTED",
    "VaultKeyWrap",
    wrap.id,
    `Достъп до vault предоставен на ${target.name} от ${req.user!.email}`
  );
  res.status(201).json({ ok: true });
});

vaultRouter.delete("/grant/:userId", requireSuperAdmin, async (req, res) => {
  const total = await prisma.vaultKeyWrap.count();
  if (total <= 1) {
    return res.status(400).json({ error: "Не може да се премахне последният достъп — vault-ът ще стане недостъпен завинаги" });
  }
  const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
  try {
    await prisma.vaultKeyWrap.delete({ where: { userId: req.params.userId } });
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
  await logAction(
    req.user!.sub,
    "VAULT_ACCESS_REVOKED",
    "VaultKeyWrap",
    req.params.userId,
    `Достъп до vault отнет от ${target?.name ?? req.params.userId} от ${req.user!.email}`
  );
  res.status(204).send();
});

const entryInclude = {
  createdBy: { select: { id: true, name: true, email: true } },
} as const;

vaultRouter.get("/entries", requireVaultAccess, async (_req, res) => {
  const entries = await prisma.vaultEntry.findMany({ include: entryInclude, orderBy: { createdAt: "desc" } });
  res.json(entries);
});

const entrySchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
});

vaultRouter.post("/entries", requireVaultAccess, async (req, res) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const entry = await prisma.vaultEntry.create({
    data: { ...parsed.data, createdById: req.user!.sub },
    include: entryInclude,
  });
  await logAction(req.user!.sub, "VAULT_ENTRY_CREATED", "VaultEntry", entry.id, `Нов запис във vault-а от ${req.user!.email}`);
  res.status(201).json(entry);
});

vaultRouter.patch("/entries/:id", requireVaultAccess, async (req, res) => {
  const parsed = entrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const entry = await prisma.vaultEntry.update({
      where: { id: req.params.id },
      data: parsed.data,
      include: entryInclude,
    });
    await logAction(req.user!.sub, "VAULT_ENTRY_UPDATED", "VaultEntry", entry.id, `Запис във vault-а редактиран от ${req.user!.email}`);
    res.json(entry);
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

vaultRouter.delete("/entries/:id", requireVaultAccess, async (req, res) => {
  try {
    await prisma.vaultEntry.delete({ where: { id: req.params.id } });
    await logAction(req.user!.sub, "VAULT_ENTRY_DELETED", "VaultEntry", req.params.id, `Запис във vault-а изтрит от ${req.user!.email}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});
