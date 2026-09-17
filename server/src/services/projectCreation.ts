import { Prisma } from "@prisma/client";
import { formatDateTime } from "../lib/dateFormat";
import { logAction } from "../lib/auditLog";
import { prisma } from "../lib/prisma";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

// A step past the first has no real deadline yet — this placeholder is never
// acted on by the scanner (status stays "BLOCKED", which isn't in any status
// list the scanner scans) until the approve route replaces it with a real
// one once the previous step is approved.
const FAR_FUTURE_PLACEHOLDER = new Date("9999-12-31T00:00:00.000Z");

const stepInclude = {
  assignee: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      telegramChatId: true,
      slackMemberId: true,
      whatsappPhone: true,
      viberUserId: true,
      googleCalendarId: true,
    },
  },
  owner: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      telegramChatId: true,
      slackMemberId: true,
      whatsappPhone: true,
      viberUserId: true,
      googleCalendarId: true,
    },
  },
} satisfies Prisma.TaskInclude;

type StepTask = Prisma.TaskGetPayload<{ include: typeof stepInclude }>;

export interface ProjectStepInput {
  assigneeId: string;
  title: string;
  description?: string | null;
  definitionOfDone: string;
  dodSource?: "stated" | "ai_suggested" | "admin" | null;
  ownerId?: string | null;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  // Step 1 only.
  deadline?: Date;
  // Steps 2+ only — how many days after the previous step is approved this one's deadline lands.
  delayDays?: number;
}

export interface CreateProjectInput {
  title: string;
  steps: ProjectStepInput[];
  createdById: string;
}

/**
 * The single place a real multi-step Project (a chain of 2-4 Tasks, each
 * possibly to a different person, only the next one active once the one
 * before it is approved) gets created and its notification/broadcast/audit
 * side effects fire — shared by the manual POST /projects route and the
 * voice-to-tasks chain-approval route, so an approved voice-detected chain
 * behaves identically to one built by hand instead of a second, drifting
 * copy of this logic (mirrors createTaskAndNotify's own role for single
 * tasks). Callers are responsible for their own authorization checks (who's
 * allowed to assign a multi-step project to whom) — this only validates
 * that people referenced actually exist and that a self-assigned step has
 * an Admin Owner, the same data-integrity rule createTaskAndNotify doesn't
 * need to enforce itself since a single task's caller already does.
 */
export async function createProjectAndNotify(input: CreateProjectInput): Promise<{ project: { id: string; title: string }; steps: StepTask[] }> {
  for (const step of input.steps) {
    const assignee = await prisma.user.findUnique({ where: { id: step.assigneeId } });
    if (!assignee) throw new Error(`Служител не е намерен: ${step.assigneeId}`);

    if (step.ownerId && step.ownerId === step.assigneeId) {
      throw new Error(`Owner-ът не може да е самият изпълнител ("${step.title}")`);
    }
    const isSelfAssign = step.assigneeId === input.createdById;
    if (isSelfAssign) {
      if (!step.ownerId) throw new Error(`Самозададена стъпка ("${step.title}") трябва да има Owner — администратор`);
      const owner = await prisma.user.findUnique({ where: { id: step.ownerId } });
      if (!owner || owner.role !== "ADMIN") {
        throw new Error(`Owner-ът на самозададена стъпка ("${step.title}") трябва да е администратор`);
      }
    } else if (step.ownerId) {
      const owner = await prisma.user.findUnique({ where: { id: step.ownerId } });
      if (!owner) throw new Error("Owner not found");
    }
  }

  const project = await prisma.project.create({ data: { title: input.title, createdById: input.createdById } });

  const createdTasks: StepTask[] = [];
  let previousStepId: string | null = null;

  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];
    const isFirst = i === 0;
    const stepTask: StepTask = await prisma.task.create({
      data: {
        title: step.title,
        description: step.description,
        definitionOfDone: step.definitionOfDone,
        dodSource: step.dodSource ?? "admin",
        assigneeId: step.assigneeId,
        ownerId: step.ownerId,
        createdById: input.createdById,
        priority: step.priority,
        deadline: isFirst ? step.deadline! : FAR_FUTURE_PLACEHOLDER,
        status: isFirst ? "PENDING" : "BLOCKED",
        projectId: project.id,
        chainOrder: i + 1,
        delayDaysAfterPrevious: isFirst ? null : step.delayDays,
        previousStepId: isFirst ? null : previousStepId,
      },
      include: stepInclude,
    });
    createdTasks.push(stepTask);
    previousStepId = stepTask.id;
  }

  // Notify every step's assignee and owner about the whole chain up front —
  // even for a step that won't start for a while, so nobody is caught by
  // surprise once their turn actually comes.
  for (let i = 0; i < createdTasks.length; i++) {
    const task = createdTasks[i];
    const isFirst = i === 0;
    const prevTitle = isFirst ? null : createdTasks[i - 1].title;
    const delayText = task.delayDaysAfterPrevious
      ? `${task.delayDaysAfterPrevious} ${task.delayDaysAfterPrevious === 1 ? "ден" : "дни"}`
      : "";

    const assigneeBody = isFirst
      ? `Част си от проект "${project.title}". Твоята стъпка "${task.title}" е активна веднага — срок ${formatDateTime(task.deadline)}.\n\n${task.description ?? ""}`
      : `Част си от проект "${project.title}". След като задача "${prevTitle}" бъде изпълнена (одобрена), ще трябва да изпълниш "${task.title}" — срок ${delayText} от този момент.\n\n${task.description ?? ""}`;
    await dispatchToAllChannels(toNotificationTarget(task.assignee), { subject: `Проект: ${project.title}`, body: assigneeBody }, { taskId: task.id });

    if (task.owner) {
      const ownerBody = isFirst
        ? `Ти си Owner на стъпка "${task.title}" от проект "${project.title}" (изпълнител: ${task.assignee.name}) — срок ${formatDateTime(task.deadline)}.`
        : `Ти си Owner на стъпка "${task.title}" от проект "${project.title}" (изпълнител: ${task.assignee.name}). Ще стане активна след като "${prevTitle}" бъде изпълнена, със срок ${delayText} след това.`;
      await dispatchToAllChannels(toNotificationTarget(task.owner), { subject: `Проект: ${project.title}`, body: ownerBody }, { taskId: task.id });
    }
  }

  const creator = await prisma.user.findUnique({ where: { id: input.createdById }, select: { email: true } });
  await broadcastToAdmins({
    subject: "Нов проект създаден",
    body: `"${project.title}" (от ${creator?.email ?? input.createdById}) — ${createdTasks.length} стъпки: ${createdTasks.map((t) => `${t.assignee.name} ("${t.title}")`).join(" → ")}.`,
  });
  await logAction(
    input.createdById,
    "TASK_CREATED",
    "Task",
    createdTasks[0].id,
    `Създаден проект "${project.title}" (${createdTasks.length} стъпки: ${createdTasks.map((t) => t.assignee.name).join(" → ")})`
  );

  return { project, steps: createdTasks };
}
