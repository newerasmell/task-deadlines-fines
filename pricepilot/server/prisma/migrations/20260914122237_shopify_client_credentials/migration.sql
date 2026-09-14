/*
  Warnings:

  - You are about to drop the column `adminApiToken` on the `Store` table. All the data in the column will be lost.
  - Added the required column `shopifyClientId` to the `Store` table without a default value. This is not possible if the table is not empty.
  - Added the required column `shopifyClientSecret` to the `Store` table without a default value. This is not possible if the table is not empty.

*/
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
    "pricingStrategy" TEXT NOT NULL DEFAULT 'undercut_min',
    "undercutPct" REAL NOT NULL DEFAULT 1,
    "priceEnding" TEXT,
    "minMarginPct" REAL NOT NULL DEFAULT 10,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
-- Shopify's admin-created-custom-app token system (the old adminApiToken this
-- column replaces) was deprecated for new apps; every store row predates the
-- client_credentials switch and has no way to supply the two new required
-- columns, so they're cleared here — re-add stores from Settings afterward.
DELETE FROM "Store";
INSERT INTO "new_Store" ("createdAt", "currency", "id", "marketCode", "minMarginPct", "myshopifyDomain", "name", "priceEnding", "pricingStrategy", "undercutPct", "updatedAt") SELECT "createdAt", "currency", "id", "marketCode", "minMarginPct", "myshopifyDomain", "name", "priceEnding", "pricingStrategy", "undercutPct", "updatedAt" FROM "Store";
DROP TABLE "Store";
ALTER TABLE "new_Store" RENAME TO "Store";
CREATE UNIQUE INDEX "Store_myshopifyDomain_key" ON "Store"("myshopifyDomain");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
