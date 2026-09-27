-- CreateTable
CREATE TABLE "ScheduledNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "taskId" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "deadline" DATETIME,
    "sendAfter" DATETIME NOT NULL,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScheduledNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ScheduledNotification_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'EMPLOYEE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "canAssignTasks" BOOLEAN NOT NULL DEFAULT false,
    "canAccessSubscriptions" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "telegramChatId" TEXT,
    "slackMemberId" TEXT,
    "whatsappPhone" TEXT,
    "viberUserId" TEXT,
    "googleCalendarId" TEXT,
    "googleRefreshToken" TEXT,
    "googleConnectedAt" DATETIME,
    "voiceAssignmentNotes" TEXT,
    "voiceAssignOnlyWhenNamed" BOOLEAN NOT NULL DEFAULT false,
    "businessHoursOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("active", "canAccessSubscriptions", "canAssignTasks", "createdAt", "email", "googleCalendarId", "googleConnectedAt", "googleRefreshToken", "id", "isSuperAdmin", "name", "passwordHash", "phone", "role", "slackMemberId", "telegramChatId", "updatedAt", "viberUserId", "voiceAssignOnlyWhenNamed", "voiceAssignmentNotes", "whatsappPhone") SELECT "active", "canAccessSubscriptions", "canAssignTasks", "createdAt", "email", "googleCalendarId", "googleConnectedAt", "googleRefreshToken", "id", "isSuperAdmin", "name", "passwordHash", "phone", "role", "slackMemberId", "telegramChatId", "updatedAt", "viberUserId", "voiceAssignOnlyWhenNamed", "voiceAssignmentNotes", "whatsappPhone" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ScheduledNotification_sentAt_sendAfter_idx" ON "ScheduledNotification"("sentAt", "sendAfter");
