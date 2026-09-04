-- AlterTable
ALTER TABLE "User" ADD COLUMN "canAccessSubscriptions" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "dueDate" DATETIME NOT NULL,
    "amount" REAL,
    "currency" TEXT DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ownerId" TEXT,
    "createdById" TEXT NOT NULL,
    "reminder30dSentAt" DATETIME,
    "reminder15dSentAt" DATETIME,
    "lastDailyReminderAt" DATETIME,
    "lastPeriodicReminderAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
