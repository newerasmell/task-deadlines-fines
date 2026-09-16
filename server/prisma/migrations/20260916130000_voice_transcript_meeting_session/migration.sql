-- AlterTable
ALTER TABLE "VoiceTranscript" ADD COLUMN "meetingSessionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "VoiceTranscript_meetingSessionId_key" ON "VoiceTranscript"("meetingSessionId");

