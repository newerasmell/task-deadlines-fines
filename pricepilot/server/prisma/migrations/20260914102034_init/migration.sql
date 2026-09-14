-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "myshopifyDomain" TEXT NOT NULL,
    "adminApiToken" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "pricingStrategy" TEXT NOT NULL DEFAULT 'undercut_min',
    "undercutPct" REAL NOT NULL DEFAULT 1,
    "priceEnding" TEXT,
    "minMarginPct" REAL NOT NULL DEFAULT 10,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "searchUrlTemplate" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRefreshedAt" DATETIME,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Source_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "vendor" TEXT,
    "handle" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "price" REAL NOT NULL,
    "compareAtPrice" REAL,
    "inventoryQuantity" INTEGER,
    "imageUrl" TEXT,
    "priority" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Product_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Cost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "skuOrEan" TEXT NOT NULL,
    "cost" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Cost_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompetitorPrice" (
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
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CompetitorPrice_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompetitorPriceHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompetitorPriceHistory_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ManualMatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "competitorUrlOrEan" TEXT NOT NULL,
    "resolvedMatchKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ManualMatch_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManualMatch_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManualMatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PublishLog" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PublishLog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_myshopifyDomain_key" ON "Store"("myshopifyDomain");

-- CreateIndex
CREATE INDEX "Product_storeId_barcode_idx" ON "Product"("storeId", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "Product_storeId_shopifyVariantId_key" ON "Product"("storeId", "shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "Cost_storeId_skuOrEan_key" ON "Cost"("storeId", "skuOrEan");

-- CreateIndex
CREATE INDEX "CompetitorPrice_sourceId_productId_idx" ON "CompetitorPrice"("sourceId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorPrice_sourceId_matchKey_key" ON "CompetitorPrice"("sourceId", "matchKey");

-- CreateIndex
CREATE INDEX "CompetitorPriceHistory_sourceId_matchKey_fetchedAt_idx" ON "CompetitorPriceHistory"("sourceId", "matchKey", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManualMatch_sourceId_productId_key" ON "ManualMatch"("sourceId", "productId");

-- CreateIndex
CREATE INDEX "PublishLog_storeId_createdAt_idx" ON "PublishLog"("storeId", "createdAt");
