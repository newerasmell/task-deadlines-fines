import { Router } from "express";
import { z } from "zod";
import { logAudit } from "../lib/audit";
import { prisma } from "../lib/prisma";

export const groupsRouter = Router();

groupsRouter.get("/", async (_req, res) => {
  const groups = await prisma.group.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { stores: true } } },
  });
  res.json(groups.map((g) => ({ id: g.id, name: g.name, createdAt: g.createdAt, storeCount: g._count.stores })));
});

const nameSchema = z.object({ name: z.string().min(1) });

groupsRouter.post("/", async (req, res) => {
  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const group = await prisma.group.create({ data: { name: parsed.data.name } });
  await logAudit(req.userId!, "GROUP_CREATED", "Group", group.id, `Added group ${group.name}`);
  res.status(201).json({ id: group.id, name: group.name, createdAt: group.createdAt, storeCount: 0 });
});

groupsRouter.patch("/:id", async (req, res) => {
  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const group = await prisma.group.update({ where: { id: req.params.id }, data: { name: parsed.data.name } });
    await logAudit(req.userId!, "GROUP_UPDATED", "Group", group.id, `Renamed group to ${group.name}`);
    res.json({ id: group.id, name: group.name, createdAt: group.createdAt });
  } catch {
    res.status(404).json({ error: "Group not found" });
  }
});

// Deleting a group never touches its stores — Store.groupId just falls
// back to null (onDelete: SetNull) and they show up under "Ungrouped".
groupsRouter.delete("/:id", async (req, res) => {
  try {
    const group = await prisma.group.delete({ where: { id: req.params.id } });
    await logAudit(req.userId!, "GROUP_DELETED", "Group", group.id, `Deleted group ${group.name}`);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "Group not found" });
  }
});
