-- AlterTable
ALTER TABLE "TaskSubmission" ADD COLUMN "reviewFinalReminderSentAt" DATETIME;
ALTER TABLE "TaskSubmission" ADD COLUMN "lastPeriodicReviewReminderAt" DATETIME;
