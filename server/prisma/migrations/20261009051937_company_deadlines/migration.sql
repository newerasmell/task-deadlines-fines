-- CreateTable
CREATE TABLE "CompanyDeadline" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "company" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" DATETIME NOT NULL,
    "amount" REAL,
    "currency" TEXT DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "recurrence" TEXT NOT NULL DEFAULT 'NONE',
    "createdById" TEXT NOT NULL,
    "reminder30dSentAt" DATETIME,
    "reminder15dSentAt" DATETIME,
    "lastDailyReminderAt" DATETIME,
    "lastPeriodicReminderAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CompanyDeadline_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
