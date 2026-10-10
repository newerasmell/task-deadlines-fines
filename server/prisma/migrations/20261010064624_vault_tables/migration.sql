/*
  Warnings:

  - You are about to drop the `VaultKeyWrap` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `tableId` to the `VaultEntry` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "VaultKeyWrap_userId_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "VaultKeyWrap";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "VaultUserKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "iterations" INTEGER NOT NULL DEFAULT 600000,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VaultUserKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VaultTable" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VaultTable_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VaultTableMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "wrappedKeyIv" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VaultTableMember_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "VaultTable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VaultTableMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VaultTableMember_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VaultEntryHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VaultEntryHistory_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "VaultTable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VaultEntryHistory_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "VaultEntry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VaultEntryHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_VaultEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VaultEntry_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "VaultTable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VaultEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_VaultEntry" ("ciphertext", "createdAt", "createdById", "id", "iv", "updatedAt") SELECT "ciphertext", "createdAt", "createdById", "id", "iv", "updatedAt" FROM "VaultEntry";
DROP TABLE "VaultEntry";
ALTER TABLE "new_VaultEntry" RENAME TO "VaultEntry";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "VaultUserKey_userId_key" ON "VaultUserKey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VaultTableMember_tableId_userId_key" ON "VaultTableMember"("tableId", "userId");
