-- DropIndex
DROP INDEX "Store_groupId_idx";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CompetitorPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "productId" TEXT,
    "matchKey" TEXT NOT NULL,
    "competitorTitle" TEXT,
    "competitorSku" TEXT,
    "competitorBarcode" TEXT,
    "price" REAL NOT NULL,
    "currency" TEXT NOT NULL,
    "url" TEXT,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CompetitorPrice_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CompetitorPrice" ("competitorBarcode", "competitorSku", "competitorTitle", "createdAt", "currency", "fetchedAt", "id", "matchKey", "price", "productId", "sourceId", "updatedAt", "url") SELECT "competitorBarcode", "competitorSku", "competitorTitle", "createdAt", "currency", "fetchedAt", "id", "matchKey", "price", "productId", "sourceId", "updatedAt", "url" FROM "CompetitorPrice";
DROP TABLE "CompetitorPrice";
ALTER TABLE "new_CompetitorPrice" RENAME TO "CompetitorPrice";
CREATE INDEX "CompetitorPrice_sourceId_productId_idx" ON "CompetitorPrice"("sourceId", "productId");
CREATE UNIQUE INDEX "CompetitorPrice_sourceId_matchKey_key" ON "CompetitorPrice"("sourceId", "matchKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
