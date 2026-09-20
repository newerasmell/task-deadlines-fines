import { prisma } from "./prisma";

export function activeAdminCount(): Promise<number> {
  return prisma.user.count({ where: { active: true, isUltimateAdmin: true } });
}
