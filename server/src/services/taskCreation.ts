import { logAction } from "../lib/auditLog";
import { formatDateTime } from "../lib/dateFormat";
import { prisma } from "../lib/prisma";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

const notifiableUserSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  telegramChatId: true,
  slackMemberId: true,
  whatsappPhone: true,
  viberUserId: true,
  googleCalendarId: true,
} as const;

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  assigneeId: string;
  ownerId?: string | null;
  deadline: Date;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  createdById: string;
}

/**
 * The single place a real Task gets created and its "you got a new task" /
 * "you're the reviewing Owner" / admin-broadcast / audit-log side effects
 * fire — shared by the manual POST /tasks route and the voice-to-tasks
 * draft-approval route, so an approved voice draft gets exactly the same
 * reminders, fines-on-overdue, and visibility as any other task instead of
 * a second, drifting copy of this logic. Callers are responsible for their
 * own authorization checks (who's allowed to assign to whom) — this only
 * validates that the assignee/owner actually exist.
 */
export async function createTaskAndNotify(input: CreateTaskInput) {
  const assignee = await prisma.user.findUnique({ where: { id: input.assigneeId } });
  if (!assignee) throw new Error("Assignee not found");
  if (input.ownerId) {
    const owner = await prisma.user.findUnique({ where: { id: input.ownerId } });
    if (!owner) throw new Error("Owner not found");
  }

  const task = await prisma.task.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      assigneeId: input.assigneeId,
      ownerId: input.ownerId ?? null,
      deadline: input.deadline,
      priority: input.priority,
      createdById: input.createdById,
    },
    include: { assignee: { select: notifiableUserSelect }, owner: { select: notifiableUserSelect } },
  });

  await dispatchToAllChannels(
    toNotificationTarget(assignee),
    {
      subject: `Нова задача: ${task.title}`,
      body: `Получи нова задача със срок ${formatDateTime(task.deadline)}.\n\n${task.description ?? ""}\n\nЗакъснението без основателна причина води до автоматична глоба.`,
      deadline: task.deadline,
    },
    { taskId: task.id }
  );
  if (task.owner) {
    await dispatchToAllChannels(
      toNotificationTarget(task.owner),
      {
        subject: `Назначен си като преглеждащ: ${task.title}`,
        body: `Ти си Owner (преглеждащ) на задача "${task.title}" (изпълнител: ${assignee.name}, срок ${formatDateTime(task.deadline)}). Ще трябва да прегледаш работата, след като бъде подадена.`,
        deadline: task.deadline,
      },
      { taskId: task.id }
    );
  }
  await broadcastToAdmins({
    subject: "Нова задача създадена",
    body: `"${task.title}" → ${assignee.name}, срок ${formatDateTime(task.deadline)}.`,
  });
  await logAction(input.createdById, "TASK_CREATED", "Task", task.id, `Създадена задача "${task.title}" → ${assignee.name}`);

  return task;
}
