-- CreateTable
CREATE TABLE "ScrapeAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "found" BOOLEAN NOT NULL,
    "price" REAL,
    "error" TEXT,
    "url" TEXT NOT NULL,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScrapeAttempt_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScrapeAttempt_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ScrapeAttempt_sourceId_attemptedAt_idx" ON "ScrapeAttempt"("sourceId", "attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScrapeAttempt_sourceId_productId_key" ON "ScrapeAttempt"("sourceId", "productId");
