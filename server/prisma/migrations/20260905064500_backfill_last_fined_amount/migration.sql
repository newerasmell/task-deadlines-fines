-- Before this release, every escalation-day fine stored the RULE'S
-- cumulative total (base + perDay * extra days) in Fine.amount, not just
-- that day's increment — the bug being fixed in the app code alongside this
-- migration. For a task/review already mid-escalation, lastFinedAmount
-- would otherwise start out NULL and the next escalation would treat 0 as
-- the "already charged" baseline, charging the full cumulative total AGAIN
-- on top of what's already been charged — worse than the original bug.
-- Backfill it from the most recent matching fine's (pre-fix, cumulative)
-- amount, which under the old code was exactly that cumulative total.
UPDATE "Task"
SET "lastFinedAmount" = (
  SELECT f."amount" FROM "Fine" f
  WHERE f."taskId" = "Task"."id"
    AND f."userId" = "Task"."assigneeId"
    AND f."reason" LIKE 'Неоснователно закъснение%'
  ORDER BY f."createdAt" DESC
  LIMIT 1
)
WHERE "Task"."lastFinedDaysLate" IS NOT NULL;

UPDATE "TaskSubmission"
SET "reviewLastFinedAmount" = (
  SELECT f."amount" FROM "Fine" f
  JOIN "Task" t ON t."id" = "TaskSubmission"."taskId"
  WHERE f."taskId" = "TaskSubmission"."taskId"
    AND f."userId" = t."ownerId"
    AND f."reason" LIKE 'Забавен преглед%'
  ORDER BY f."createdAt" DESC
  LIMIT 1
)
WHERE "TaskSubmission"."reviewLastFinedDaysLate" IS NOT NULL;
