-- AlterTable
ALTER TABLE "ProductSales" ADD COLUMN "period20dEnd" DATETIME;
ALTER TABLE "ProductSales" ADD COLUMN "period20dStart" DATETIME;
ALTER TABLE "ProductSales" ADD COLUMN "revenue20d" REAL;
ALTER TABLE "ProductSales" ADD COLUMN "unitsSold20d" INTEGER;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaignType" TEXT NOT NULL,
    "discountPct" REAL NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "revertedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Campaign_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Campaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PublishLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productTitle" TEXT,
    "oldPrice" REAL NOT NULL,
    "newPrice" REAL NOT NULL,
    "oldCompareAt" REAL,
    "newCompareAt" REAL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "source" TEXT NOT NULL,
    "transferFromStoreName" TEXT,
    "revertedAt" DATETIME,
    "campaignId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PublishLog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PublishLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PublishLog" ("createdAt", "errorMessage", "id", "newCompareAt", "newPrice", "oldCompareAt", "oldPrice", "productTitle", "revertedAt", "source", "status", "storeId", "transferFromStoreName", "variantId") SELECT "createdAt", "errorMessage", "id", "newCompareAt", "newPrice", "oldCompareAt", "oldPrice", "productTitle", "revertedAt", "source", "status", "storeId", "transferFromStoreName", "variantId" FROM "PublishLog";
DROP TABLE "PublishLog";
ALTER TABLE "new_PublishLog" RENAME TO "PublishLog";
CREATE INDEX "PublishLog_storeId_createdAt_idx" ON "PublishLog"("storeId", "createdAt");
CREATE INDEX "PublishLog_campaignId_idx" ON "PublishLog"("campaignId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Campaign_storeId_status_idx" ON "Campaign"("storeId", "status");
