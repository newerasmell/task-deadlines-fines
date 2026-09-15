-- CreateTable
CREATE TABLE "VoiceTranscript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "originalFilename" TEXT,
    "meetRecordingId" TEXT,
    "transcriptText" TEXT NOT NULL,
    "durationSeconds" INTEGER,
    "languageDetected" TEXT,
    "createdById" TEXT,
    "whisperCostUsd" REAL,
    "claudeInputTokens" INTEGER,
    "claudeOutputTokens" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoiceTranscript_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VoiceTaskDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transcriptId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigneeKey" TEXT,
    "resolvedAssigneeId" TEXT,
    "deadline" DATETIME NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sourceQuote" TEXT NOT NULL,
    "createdByAi" BOOLEAN NOT NULL DEFAULT true,
    "approvedAt" DATETIME,
    "approvedTaskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VoiceTaskDraft_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "VoiceTranscript" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VoiceTaskDraft_resolvedAssigneeId_fkey" FOREIGN KEY ("resolvedAssigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VoiceTaskDraft_approvedTaskId_fkey" FOREIGN KEY ("approvedTaskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VoiceProcessingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transcriptId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VoiceProcessingJob_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "VoiceTranscript" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VoiceProcessingJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Fine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "userId" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "reason" TEXT NOT NULL,
    "daysLate" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "waivedById" TEXT,
    "waivedReason" TEXT,
    "paidAt" DATETIME,
    "paidById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Fine_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Fine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Fine_waivedById_fkey" FOREIGN KEY ("waivedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Fine_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Fine" ("amount", "createdAt", "currency", "daysLate", "id", "paidAt", "paidById", "reason", "status", "taskId", "updatedAt", "userId", "waivedById", "waivedReason") SELECT "amount", "createdAt", "currency", "daysLate", "id", "paidAt", "paidById", "reason", "status", "taskId", "updatedAt", "userId", "waivedById", "waivedReason" FROM "Fine";
DROP TABLE "Fine";
ALTER TABLE "new_Fine" RENAME TO "Fine";
CREATE TABLE "new_Leave" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Leave_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Leave_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Leave" ("createdAt", "createdById", "endDate", "id", "note", "startDate", "userId") SELECT "createdAt", "createdById", "endDate", "id", "note", "startDate", "userId" FROM "Leave";
DROP TABLE "Leave";
ALTER TABLE "new_Leave" RENAME TO "Leave";
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Project_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("createdAt", "createdById", "id", "title") SELECT "createdAt", "createdById", "id", "title" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE TABLE "new_RescheduleRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "leaveId" TEXT,
    "requestedById" TEXT NOT NULL,
    "currentDeadline" DATETIME NOT NULL,
    "proposedDeadline" DATETIME NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RescheduleRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RescheduleRequest_leaveId_fkey" FOREIGN KEY ("leaveId") REFERENCES "Leave" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RescheduleRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RescheduleRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_RescheduleRequest" ("createdAt", "currentDeadline", "decidedAt", "decidedById", "decisionNote", "id", "leaveId", "note", "proposedDeadline", "requestedById", "status", "taskId") SELECT "createdAt", "currentDeadline", "decidedAt", "decidedById", "decisionNote", "id", "leaveId", "note", "proposedDeadline", "requestedById", "status", "taskId" FROM "RescheduleRequest";
DROP TABLE "RescheduleRequest";
ALTER TABLE "new_RescheduleRequest" RENAME TO "RescheduleRequest";
CREATE TABLE "new_Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "dueDate" DATETIME NOT NULL,
    "amount" REAL,
    "currency" TEXT DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "assigneeId" TEXT NOT NULL,
    "ownerId" TEXT,
    "createdById" TEXT NOT NULL,
    "reminder30dSentAt" DATETIME,
    "reminder15dSentAt" DATETIME,
    "lastDailyReminderAt" DATETIME,
    "lastPeriodicReminderAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subscription_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Subscription_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Subscription_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Subscription" ("amount", "assigneeId", "category", "createdAt", "createdById", "currency", "description", "dueDate", "id", "lastDailyReminderAt", "lastPeriodicReminderAt", "ownerId", "reminder15dSentAt", "reminder30dSentAt", "status", "title", "updatedAt") SELECT "amount", "assigneeId", "category", "createdAt", "createdById", "currency", "description", "dueDate", "id", "lastDailyReminderAt", "lastPeriodicReminderAt", "ownerId", "reminder15dSentAt", "reminder30dSentAt", "status", "title", "updatedAt" FROM "Subscription";
DROP TABLE "Subscription";
ALTER TABLE "new_Subscription" RENAME TO "Subscription";
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigneeId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "ownerId" TEXT,
    "templateId" TEXT,
    "projectId" TEXT,
    "chainOrder" INTEGER,
    "delayDaysAfterPrevious" INTEGER,
    "previousStepId" TEXT,
    "deadline" DATETIME NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reminder24hSentAt" DATETIME,
    "reminder4hSentAt" DATETIME,
    "lastPeriodicReminderAt" DATETIME,
    "lastEscalationAt" DATETIME,
    "lastFinedDaysLate" INTEGER,
    "lastFinedAmount" REAL,
    "completedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Task_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "RecurringTaskTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_previousStepId_fkey" FOREIGN KEY ("previousStepId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("assigneeId", "chainOrder", "completedAt", "createdAt", "createdById", "deadline", "delayDaysAfterPrevious", "deletedAt", "description", "id", "lastEscalationAt", "lastFinedAmount", "lastFinedDaysLate", "lastPeriodicReminderAt", "ownerId", "previousStepId", "priority", "projectId", "reminder24hSentAt", "reminder4hSentAt", "status", "templateId", "title", "updatedAt") SELECT "assigneeId", "chainOrder", "completedAt", "createdAt", "createdById", "deadline", "delayDaysAfterPrevious", "deletedAt", "description", "id", "lastEscalationAt", "lastFinedAmount", "lastFinedDaysLate", "lastPeriodicReminderAt", "ownerId", "previousStepId", "priority", "projectId", "reminder24hSentAt", "reminder4hSentAt", "status", "templateId", "title", "updatedAt" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE UNIQUE INDEX "Task_previousStepId_key" ON "Task"("previousStepId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "VoiceTranscript_meetRecordingId_key" ON "VoiceTranscript"("meetRecordingId");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceTaskDraft_approvedTaskId_key" ON "VoiceTaskDraft"("approvedTaskId");

