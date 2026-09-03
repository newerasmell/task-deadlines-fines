-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "projectId" TEXT;
ALTER TABLE "Task" ADD COLUMN "chainOrder" INTEGER;
ALTER TABLE "Task" ADD COLUMN "delayDaysAfterPrevious" INTEGER;
ALTER TABLE "Task" ADD COLUMN "previousStepId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Task_previousStepId_key" ON "Task"("previousStepId");
