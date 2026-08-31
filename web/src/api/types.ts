export type Role = "ADMIN" | "EMPLOYEE";
export type TaskStatus = "PENDING" | "IN_PROGRESS" | "DONE" | "OVERDUE" | "CANCELLED";
export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type FineStatus = "ACTIVE" | "WAIVED" | "PAID";
export type Channel = "TELEGRAM" | "SLACK" | "EMAIL" | "WHATSAPP" | "VIBER" | "GOOGLE_CALENDAR";

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

export interface Task {
  id: string;
  title: string;
  description: string | null;
  assigneeId: string;
  assignee: { id: string; name: string; email: string };
  createdBy: { id: string; name: string; email: string };
  deadline: string;
  priority: Priority;
  status: TaskStatus;
  completedAt: string | null;
  createdAt: string;
  fines?: Fine[];
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

export interface ChannelStatus {
  channel: Channel;
  configured: boolean;
}

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
