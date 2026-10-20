-- AlterTable
ALTER TABLE "User" ADD COLUMN "telegramLinkToken" TEXT;
ALTER TABLE "User" ADD COLUMN "telegramLinkTokenExpiresAt" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramLinkToken_key" ON "User"("telegramLinkToken");

