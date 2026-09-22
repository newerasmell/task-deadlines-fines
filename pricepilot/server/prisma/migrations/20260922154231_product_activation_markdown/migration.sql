-- AlterTable
ALTER TABLE "Product" ADD COLUMN "activatedAt" DATETIME;
ALTER TABLE "Product" ADD COLUMN "priceAtActivation" REAL;
ALTER TABLE "Product" ADD COLUMN "shopifyPublishedAt" DATETIME;
ALTER TABLE "Product" ADD COLUMN "shopifyStatus" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Store" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "myshopifyDomain" TEXT NOT NULL,
    "shopifyClientId" TEXT NOT NULL,
    "shopifyClientSecret" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "groupId" TEXT,
    "pricingStrategy" TEXT NOT NULL DEFAULT 'undercut_min',
    "undercutPct" REAL NOT NULL DEFAULT 1,
    "priceEnding" TEXT,
    "minMarginPct" REAL NOT NULL DEFAULT 10,
    "pricingProfile" TEXT NOT NULL DEFAULT 'competitor',
    "salesAnalyticsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "markdownEnabled" BOOLEAN NOT NULL DEFAULT false,
    "markdownCollectionId" TEXT,
    "markdownAfterDays" INTEGER NOT NULL DEFAULT 8,
    "markdownCeilingPct" REAL NOT NULL DEFAULT 12.5,
    "ga4PropertyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Store_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Store_markdownCollectionId_fkey" FOREIGN KEY ("markdownCollectionId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Store" ("createdAt", "currency", "ga4PropertyId", "groupId", "id", "marketCode", "minMarginPct", "myshopifyDomain", "name", "priceEnding", "pricingProfile", "pricingStrategy", "salesAnalyticsEnabled", "shopifyClientId", "shopifyClientSecret", "undercutPct", "updatedAt") SELECT "createdAt", "currency", "ga4PropertyId", "groupId", "id", "marketCode", "minMarginPct", "myshopifyDomain", "name", "priceEnding", "pricingProfile", "pricingStrategy", "salesAnalyticsEnabled", "shopifyClientId", "shopifyClientSecret", "undercutPct", "updatedAt" FROM "Store";
DROP TABLE "Store";
ALTER TABLE "new_Store" RENAME TO "Store";
CREATE UNIQUE INDEX "Store_myshopifyDomain_key" ON "Store"("myshopifyDomain");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
