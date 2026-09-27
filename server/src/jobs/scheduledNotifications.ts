import { prisma } from "../lib/prisma";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

/**
 * Delivers every ScheduledNotification whose business window has now
 * opened — the other half of dispatchRespectingBusinessHours, which is what
 * creates these rows in the first place for a User.businessHoursOnly
 * recipient caught outside the window. Uses dispatchToAllChannels directly
 * (not the *RespectingBusinessHours wrapper) since sendAfter was already
 * computed to land inside a business window; re-deferring here would loop.
 */
export async function runScheduledNotificationDelivery(now: Date = new Date()): Promise<void> {
  const due = await prisma.scheduledNotification.findMany({
    where: { sentAt: null, sendAfter: { lte: now } },
    include: { user: true },
  });

  for (const sn of due) {
    await dispatchToAllChannels(
      toNotificationTarget(sn.user),
      { subject: sn.subject, body: sn.body, deadline: sn.deadline ?? undefined },
      { taskId: sn.taskId ?? undefined }
    );
    await prisma.scheduledNotification.update({ where: { id: sn.id }, data: { sentAt: now } });
  }
}
