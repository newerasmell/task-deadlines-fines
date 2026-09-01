-- CreateTable
CREATE TABLE "AssignmentScope" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leadId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssignmentScope_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AssignmentScope_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
    "phone" TEXT,
    "telegramChatId" TEXT,
    "slackMemberId" TEXT,
    "whatsappPhone" TEXT,
    "viberUserId" TEXT,
    "googleCalendarId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("active", "createdAt", "email", "googleCalendarId", "id", "name", "passwordHash", "phone", "role", "slackMemberId", "telegramChatId", "updatedAt", "viberUserId", "whatsappPhone") SELECT "active", "createdAt", "email", "googleCalendarId", "id", "name", "passwordHash", "phone", "role", "slackMemberId", "telegramChatId", "updatedAt", "viberUserId", "whatsappPhone" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentScope_leadId_employeeId_key" ON "AssignmentScope"("leadId", "employeeId");

-- DataMigration: bootstrap every pre-existing ADMIN as a super admin so
-- nobody who already had full admin access is locked out of the new
-- super-admin-only controls (granting roles/Lead status/scopes). The
-- business owner can demote the others from the Employees page afterward.
UPDATE "User" SET "isSuperAdmin" = true WHERE "role" = 'ADMIN';
