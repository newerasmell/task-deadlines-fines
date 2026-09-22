-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopifyCollectionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Category_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    CONSTRAINT "ProductCategory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductSales" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "unitsSold6m" INTEGER NOT NULL,
    "revenue6m" REAL NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductSales_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductPageViews" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "pageViews6m" INTEGER NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductPageViews_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CategoryCost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "cost" REAL NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CategoryCost_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
    "ga4PropertyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Store_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Store" ("createdAt", "currency", "groupId", "id", "marketCode", "minMarginPct", "myshopifyDomain", "name", "priceEnding", "pricingProfile", "pricingStrategy", "shopifyClientId", "shopifyClientSecret", "undercutPct", "updatedAt") SELECT "createdAt", "currency", "groupId", "id", "marketCode", "minMarginPct", "myshopifyDomain", "name", "priceEnding", "pricingProfile", "pricingStrategy", "shopifyClientId", "shopifyClientSecret", "undercutPct", "updatedAt" FROM "Store";
DROP TABLE "Store";
ALTER TABLE "new_Store" RENAME TO "Store";
CREATE UNIQUE INDEX "Store_myshopifyDomain_key" ON "Store"("myshopifyDomain");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Category_storeId_shopifyCollectionId_key" ON "Category"("storeId", "shopifyCollectionId");

-- CreateIndex
CREATE INDEX "ProductCategory_categoryId_idx" ON "ProductCategory"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_productId_categoryId_key" ON "ProductCategory"("productId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSales_productId_key" ON "ProductSales"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPageViews_productId_key" ON "ProductPageViews"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryCost_categoryId_key" ON "CategoryCost"("categoryId");
