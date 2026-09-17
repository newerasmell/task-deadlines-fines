-- CreateTable
CREATE TABLE "AmbiguousMatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "candidatesJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AmbiguousMatch_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AmbiguousMatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "searchUrlTemplate" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "autoRefresh" BOOLEAN NOT NULL DEFAULT true,
    "lastRefreshedAt" DATETIME,
    "lastTriggeredBy" TEXT,
    "lastMatchedCount" INTEGER,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Source_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Source" ("active", "baseUrl", "consecutiveFailures", "createdAt", "degraded", "id", "label", "lastError", "lastMatchedCount", "lastRefreshedAt", "searchUrlTemplate", "storeId", "type", "updatedAt") SELECT "active", "baseUrl", "consecutiveFailures", "createdAt", "degraded", "id", "label", "lastError", "lastMatchedCount", "lastRefreshedAt", "searchUrlTemplate", "storeId", "type", "updatedAt" FROM "Source";
DROP TABLE "Source";
ALTER TABLE "new_Source" RENAME TO "Source";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AmbiguousMatch_sourceId_status_idx" ON "AmbiguousMatch"("sourceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AmbiguousMatch_sourceId_productId_key" ON "AmbiguousMatch"("sourceId", "productId");

