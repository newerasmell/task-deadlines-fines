-- AlterTable
ALTER TABLE "Store" ADD COLUMN "pricingProfile" TEXT NOT NULL DEFAULT 'competitor';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "tags" TEXT;

-- CreateTable
CREATE TABLE "CodFormulaConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'target',
    "cogsPct" REAL NOT NULL DEFAULT 40,
    "fRate" REAL NOT NULL DEFAULT 5,
    "mRate" REAL NOT NULL DEFAULT 10,
    "nItems" REAL NOT NULL DEFAULT 1.3,
    "rMult" REAL NOT NULL DEFAULT 2,
    "lLoss" REAL NOT NULL DEFAULT 0,
    "fCost" REAL NOT NULL DEFAULT 5000,
    "roundStep" REAL NOT NULL DEFAULT 1,
    "discountPct" REAL NOT NULL DEFAULT 50,
    "discountTag" TEXT NOT NULL DEFAULT 'sale',
    "pricingScenario" TEXT NOT NULL DEFAULT 'avg',
    "pricingN" REAL NOT NULL DEFAULT 1000,
    "scenariosJson" TEXT NOT NULL DEFAULT '[{"key":"pess","label":"Песимистичен","A":25,"d":60,"S":7},{"key":"avg","label":"Среден","A":20,"d":62.5,"S":6},{"key":"opt","label":"Оптимистичен","A":15,"d":65,"S":5}]',
    "bracketsJson" TEXT NOT NULL DEFAULT '[{"upper":25000,"rate":4},{"upper":50000,"rate":5},{"upper":75000,"rate":6},{"upper":null,"rate":7}]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CodFormulaConfig_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CodFormulaConfig_storeId_key" ON "CodFormulaConfig"("storeId");
