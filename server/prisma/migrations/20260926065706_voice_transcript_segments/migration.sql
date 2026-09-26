-- AlterTable
ALTER TABLE "VoiceTranscript" ADD COLUMN "expectedSegmentCount" INTEGER;
ALTER TABLE "VoiceTranscript" ADD COLUMN "extractionTriggeredAt" DATETIME;

-- CreateTable
CREATE TABLE "VoiceTranscriptSegment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transcriptId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoiceTranscriptSegment_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "VoiceTranscript" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceTranscriptSegment_transcriptId_segmentIndex_key" ON "VoiceTranscriptSegment"("transcriptId", "segmentIndex");
