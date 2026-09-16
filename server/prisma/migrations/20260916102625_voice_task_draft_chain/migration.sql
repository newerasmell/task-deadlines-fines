-- AlterTable
ALTER TABLE "VoiceTaskDraft" ADD COLUMN "chainGroupId" TEXT;
ALTER TABLE "VoiceTaskDraft" ADD COLUMN "chainOrder" INTEGER;
ALTER TABLE "VoiceTaskDraft" ADD COLUMN "chainTitle" TEXT;
ALTER TABLE "VoiceTaskDraft" ADD COLUMN "delayDaysAfterPrevious" INTEGER;

