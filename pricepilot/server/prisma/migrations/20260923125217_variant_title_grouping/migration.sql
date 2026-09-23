-- AlterTable
ALTER TABLE "Product" ADD COLUMN "variantTitle" TEXT;

-- CreateIndex
CREATE INDEX "Product_storeId_shopifyProductId_idx" ON "Product"("storeId", "shopifyProductId");
