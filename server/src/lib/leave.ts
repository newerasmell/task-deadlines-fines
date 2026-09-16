import { prisma } from "./prisma";

/**
 * Whether a user is covered by an approved Leave right now — used to hold
 * back personal notification delivery (reminders, overdue/fine notices)
 * while someone's on their days off, without touching the underlying
 * deadline/fine calculation itself (see leaveHoursOverlap in
 * deadlineScanner.ts, which already excludes leave time from fine math).
 */
export async function isOnLeave(userId: string, now: Date = new Date()): Promise<boolean> {
  const leave = await prisma.leave.findFirst({
    where: { userId, startDate: { lte: now }, endDate: { gte: now } },
    select: { id: true },
  });
  return leave !== null;
}
