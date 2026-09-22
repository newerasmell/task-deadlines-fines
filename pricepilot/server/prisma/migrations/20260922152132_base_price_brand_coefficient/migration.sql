-- AlterTable
ALTER TABLE "Category" ADD COLUMN "baseMaxPrice" REAL;
ALTER TABLE "Category" ADD COLUMN "baseMinPrice" REAL;

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "coefficient" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Brand_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Brand_storeId_vendor_key" ON "Brand"("storeId", "vendor");
