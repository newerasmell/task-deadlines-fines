-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "assigneeId" TEXT;

-- Backfill: whoever created an existing entry is its assignee until edited.
UPDATE "Subscription" SET "assigneeId" = "createdById" WHERE "assigneeId" IS NULL;
