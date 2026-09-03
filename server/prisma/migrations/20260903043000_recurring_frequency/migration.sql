-- AlterTable
ALTER TABLE "RecurringTaskTemplate" ADD COLUMN "frequency" TEXT NOT NULL DEFAULT 'WEEKLY';
ALTER TABLE "RecurringTaskTemplate" ADD COLUMN "dayOfMonth" INTEGER;
