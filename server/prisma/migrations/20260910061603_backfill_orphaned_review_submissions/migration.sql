-- Before this release, a task moved off PENDING_REVIEW some other way than
-- approve/reject/complete (e.g. an admin editing its status directly)
-- left its TaskSubmission stuck at reviewStatus 'PENDING' forever — the
-- scanner's review-fine/reminder queries keyed only on reviewStatus, never
-- on the parent task's own status, so a task that looked closed kept
-- accruing a fine for its Owner every single day. Resolve every such
-- already-orphaned submission now, matching what /complete already writes
-- when it resolves one.
UPDATE "TaskSubmission"
SET "reviewStatus" = 'APPROVED',
    "reviewedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    "reviewNote" = 'Задачата вече не е "За преглед" — прегледът е автоматично затворен при поправка на бъг с ежедневно начисляване на глоби за закъснял преглед на вече приключена задача.'
WHERE "reviewStatus" = 'PENDING'
  AND "taskId" IN (SELECT "id" FROM "Task" WHERE "status" != 'PENDING_REVIEW');
