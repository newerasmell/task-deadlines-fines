-- AlterTable
ALTER TABLE "User" ADD COLUMN "inviteAcceptedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "inviteToken" TEXT;
ALTER TABLE "User" ADD COLUMN "inviteTokenExpiresAt" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "User_inviteToken_key" ON "User"("inviteToken");

-- Backfill: every row that exists at the moment THIS migration runs
-- predates the email-invite feature — none of them ever went through it,
-- they already have a real admin-set password. Marking them as already
-- "accepted" (as of their own createdAt) keeps inviteAcceptedAt IS NULL
-- meaning exactly one thing from here on: a genuinely pending invite —
-- otherwise every pre-existing employee would show a confusing "Покана:
-- чака" badge on the Employees page forever.
UPDATE "User" SET "inviteAcceptedAt" = "createdAt" WHERE "inviteAcceptedAt" IS NULL;

