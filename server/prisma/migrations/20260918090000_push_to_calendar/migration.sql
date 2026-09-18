-- AlterTable
ALTER TABLE "User" ADD COLUMN "googleRefreshToken" TEXT;
ALTER TABLE "User" ADD COLUMN "googleConnectedAt" DATETIME;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "googleEventId" TEXT;
ALTER TABLE "Task" ADD COLUMN "pushedStart" DATETIME;
ALTER TABLE "Task" ADD COLUMN "pushedDurationMinutes" INTEGER;
