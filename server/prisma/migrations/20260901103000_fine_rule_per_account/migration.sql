-- CreateTable
CREATE TABLE "FineRuleAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FineRuleAssignment_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "FineRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FineRuleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FineRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseAmount" REAL NOT NULL,
    "perDayAmount" REAL NOT NULL,
    "graceHours" REAL NOT NULL DEFAULT 0,
    "maxAmount" REAL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_FineRule" ("active", "baseAmount", "createdAt", "currency", "graceHours", "id", "maxAmount", "name", "perDayAmount", "updatedAt") SELECT "active", "baseAmount", "createdAt", "currency", "graceHours", "id", "maxAmount", "name", "perDayAmount", "updatedAt" FROM "FineRule";
DROP TABLE "FineRule";
ALTER TABLE "new_FineRule" RENAME TO "FineRule";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "FineRuleAssignment_userId_key" ON "FineRuleAssignment"("userId");

