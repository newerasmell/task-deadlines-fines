/*
  Warnings:

  - You are about to drop the column `wrappedKeyIv` on the `VaultTableMember` table. All the data in the column will be lost.
  - Added the required column `publicKey` to the `VaultUserKey` table without a default value. This is not possible if the table is not empty.
  - Added the required column `wrappedPrivateKey` to the `VaultUserKey` table without a default value. This is not possible if the table is not empty.
  - Added the required column `wrappedPrivateKeyIv` to the `VaultUserKey` table without a default value. This is not possible if the table is not empty.

  Any existing vault data is wiped as part of this migration (see the
  DELETEs below) rather than carried forward: table keys wrapped under the
  old symmetric scheme cannot be converted to the new RSA-OAEP scheme
  without each person's original plaintext master password, which was
  never stored anywhere, by design. Confirmed with the project owner that
  only test data existed at the time of this migration.
*/
PRAGMA foreign_keys=OFF;

DELETE FROM "VaultEntryHistory";
DELETE FROM "VaultEntry";
DELETE FROM "VaultTableMember";
DELETE FROM "VaultTable";
DELETE FROM "VaultUserKey";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
CREATE TABLE "new_VaultTableMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VaultTableMember_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "VaultTable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VaultTableMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VaultTableMember_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
DROP TABLE "VaultTableMember";
ALTER TABLE "new_VaultTableMember" RENAME TO "VaultTableMember";
CREATE UNIQUE INDEX "VaultTableMember_tableId_userId_key" ON "VaultTableMember"("tableId", "userId");
CREATE TABLE "new_VaultUserKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "iterations" INTEGER NOT NULL DEFAULT 600000,
    "publicKey" TEXT NOT NULL,
    "wrappedPrivateKey" TEXT NOT NULL,
    "wrappedPrivateKeyIv" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VaultUserKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
DROP TABLE "VaultUserKey";
ALTER TABLE "new_VaultUserKey" RENAME TO "VaultUserKey";
CREATE UNIQUE INDEX "VaultUserKey_userId_key" ON "VaultUserKey"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
