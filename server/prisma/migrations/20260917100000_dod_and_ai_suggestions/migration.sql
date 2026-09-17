-- AlterTable
ALTER TABLE "Task" ADD COLUMN "definitionOfDone" TEXT;
ALTER TABLE "Task" ADD COLUMN "dodSource" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_VoiceTaskDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transcriptId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigneeKey" TEXT,
    "resolvedAssigneeId" TEXT,
    "ownerKey" TEXT,
    "resolvedOwnerId" TEXT,
    "definitionOfDone" TEXT,
    "dodSource" TEXT,
    "taskType" TEXT NOT NULL DEFAULT 'extracted',
    "suggestedAssignees" TEXT,
    "deadline" DATETIME NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sourceQuote" TEXT NOT NULL,
    "createdByAi" BOOLEAN NOT NULL DEFAULT true,
    "chainGroupId" TEXT,
    "chainOrder" INTEGER,
    "delayDaysAfterPrevious" INTEGER,
    "chainTitle" TEXT,
    "approvedAt" DATETIME,
    "approvedTaskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VoiceTaskDraft_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "VoiceTranscript" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VoiceTaskDraft_resolvedAssigneeId_fkey" FOREIGN KEY ("resolvedAssigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VoiceTaskDraft_resolvedOwnerId_fkey" FOREIGN KEY ("resolvedOwnerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VoiceTaskDraft_approvedTaskId_fkey" FOREIGN KEY ("approvedTaskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_VoiceTaskDraft" ("approvedAt", "approvedTaskId", "assigneeKey", "chainGroupId", "chainOrder", "chainTitle", "createdAt", "createdByAi", "deadline", "delayDaysAfterPrevious", "description", "id", "ownerKey", "priority", "resolvedAssigneeId", "resolvedOwnerId", "sourceQuote", "status", "title", "transcriptId", "updatedAt") SELECT "approvedAt", "approvedTaskId", "assigneeKey", "chainGroupId", "chainOrder", "chainTitle", "createdAt", "createdByAi", "deadline", "delayDaysAfterPrevious", "description", "id", "ownerKey", "priority", "resolvedAssigneeId", "resolvedOwnerId", "sourceQuote", "status", "title", "transcriptId", "updatedAt" FROM "VoiceTaskDraft";
DROP TABLE "VoiceTaskDraft";
ALTER TABLE "new_VoiceTaskDraft" RENAME TO "VoiceTaskDraft";
CREATE UNIQUE INDEX "VoiceTaskDraft_approvedTaskId_key" ON "VoiceTaskDraft"("approvedTaskId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

