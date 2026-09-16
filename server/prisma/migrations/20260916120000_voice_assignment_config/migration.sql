-- CreateTable
CREATE TABLE "VoiceAssignmentConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "rulesText" TEXT,
    "updatedAt" DATETIME NOT NULL
);

