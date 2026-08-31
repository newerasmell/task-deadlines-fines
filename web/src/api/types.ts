export type Role = "ADMIN" | "EMPLOYEE";
export type TaskStatus = "PENDING" | "IN_PROGRESS" | "PENDING_REVIEW" | "DONE" | "OVERDUE" | "CANCELLED";
export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type FineStatus = "ACTIVE" | "WAIVED" | "PAID";
export type Channel = "TELEGRAM" | "SLACK" | "EMAIL" | "WHATSAPP" | "VIBER" | "GOOGLE_CALENDAR";
export type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";
export type Weekday = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";

export interface UserRef {
  id: string;
  name: string;
  email: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  phone: string | null;
  telegramChatId: string | null;
  slackMemberId: string | null;
  whatsappPhone: string | null;
  viberUserId: string | null;
  googleCalendarId: string | null;
  createdAt: string;
}

export interface Attachment {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface TaskSubmission {
  id: string;
  taskId: string;
  submittedBy: { id: string; name: string };
  note: string | null;
  reviewStatus: ReviewStatus;
  reviewDueAt: string | null;
  reviewedBy: { id: string; name: string } | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  attachments: Attachment[];
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  assigneeId: string;
  assignee: UserRef;
  createdBy: UserRef;
  ownerId: string | null;
  owner: UserRef | null;
  templateId: string | null;
  deadline: string;
  priority: Priority;
  status: TaskStatus;
  completedAt: string | null;
  createdAt: string;
  fines?: Fine[];
  submissions?: TaskSubmission[];
}

export interface Fine {
  id: string;
  taskId: string | null;
  task?: { id: string; title: string; deadline: string } | null;
  userId: string;
  user?: { id: string; name: string; email: string };
  amount: number;
  currency: string;
  reason: string;
  daysLate: number;
  status: FineStatus;
  waivedReason: string | null;
  createdAt: string;
}

export interface FineRule {
  id: string;
  name: string;
  priority: Priority | null;
  baseAmount: number;
  perDayAmount: number;
  graceHours: number;
  maxAmount: number | null;
  currency: string;
  active: boolean;
}

export interface RecurringTaskTemplate {
  id: string;
  title: string;
  description: string | null;
  assignee: UserRef;
  owner: UserRef | null;
  priority: Priority;
  daysOfWeek: string;
  timeOfDay: string;
  active: boolean;
}

export interface ChannelStatus {
  channel: Channel;
  configured: boolean;
}

export type AdminAction = "TASK_CREATED" | "TASK_UPDATED" | "TASK_DELETED" | "FINE_CREATED" | "FINE_WAIVED";

export interface AuditLogEntry {
  id: string;
  actor: { id: string; name: string; email: string };
  action: AdminAction;
  entityType: string;
  entityId: string;
  summary: string;
  details: string | null;
  createdAt: string;
}

export const ADMIN_ACTION_LABELS: Record<AdminAction, string> = {
  TASK_CREATED: "Създадена задача",
  TASK_UPDATED: "Редактирана задача",
  TASK_DELETED: "Изтрита задача",
  FINE_CREATED: "Наложена глоба",
  FINE_WAIVED: "Анулирана глоба",
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  TELEGRAM: "Telegram",
  SLACK: "Slack",
  EMAIL: "Email / Gmail",
  WHATSAPP: "WhatsApp",
  VIBER: "Viber",
  GOOGLE_CALENDAR: "Google Calendar",
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  PENDING: "Чакаща",
  IN_PROGRESS: "В прогрес",
  PENDING_REVIEW: "За преглед",
  DONE: "Завършена",
  OVERDUE: "Просрочена",
  CANCELLED: "Отменена",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: "Нисък",
  MEDIUM: "Среден",
  HIGH: "Висок",
  CRITICAL: "Критичен",
};

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  MON: "Пон",
  TUE: "Вт",
  WED: "Ср",
  THU: "Чет",
  FRI: "Пет",
  SAT: "Съб",
  SUN: "Нед",
};

export const WEEKDAYS: Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
