-- CreateTable
CREATE TABLE "SearchDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "bodyText" TEXT NOT NULL,
    "keywordsText" TEXT NOT NULL,
    "brandText" TEXT,
    "categoryText" TEXT NOT NULL,
    "attributeText" TEXT NOT NULL,
    "sku" TEXT,
    "slug" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "minPricePaise" INTEGER,
    "maxPricePaise" INTEGER,
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "popularityScore" INTEGER NOT NULL DEFAULT 0,
    "boostScore" INTEGER NOT NULL DEFAULT 0,
    "indexedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checksum" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "SearchSynonym" (
    "term" TEXT NOT NULL PRIMARY KEY,
    "synonymsJson" TEXT NOT NULL,
    "isTwoWay" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SearchQueryLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rawQuery" TEXT NOT NULL,
    "normalizedQuery" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "hasResults" BOOLEAN NOT NULL DEFAULT false,
    "filtersJson" TEXT,
    "customerId" TEXT,
    "sessionId" TEXT,
    "ip" TEXT,
    "clickedEntityType" TEXT,
    "clickedEntityId" TEXT,
    "clickPosition" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProductStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount7d" INTEGER NOT NULL DEFAULT 0,
    "wishlistCount" INTEGER NOT NULL DEFAULT 0,
    "cartAddCount" INTEGER NOT NULL DEFAULT 0,
    "purchaseCount" INTEGER NOT NULL DEFAULT 0,
    "popularityScore" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" DATETIME,
    "recomputedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductStat_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SearchIndexJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "entityType" TEXT,
    "isFull" BOOLEAN NOT NULL DEFAULT false,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "errorsJson" TEXT,
    "triggeredById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Collection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'MANUAL',
    "description" TEXT,
    "rulesJson" TEXT,
    "bannerMediaId" TEXT,
    "mobileBannerMediaId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "lastEvaluatedAt" DATETIME,
    "evaluatedCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);
INSERT INTO "new_Collection" ("bannerMediaId", "createdAt", "deletedAt", "description", "endsAt", "id", "isActive", "mobileBannerMediaId", "name", "position", "rulesJson", "seoDescription", "seoTitle", "slug", "startsAt", "type", "updatedAt", "version") SELECT "bannerMediaId", "createdAt", "deletedAt", "description", "endsAt", "id", "isActive", "mobileBannerMediaId", "name", "position", "rulesJson", "seoDescription", "seoTitle", "slug", "startsAt", "type", "updatedAt", "version" FROM "Collection";
DROP TABLE "Collection";
ALTER TABLE "new_Collection" RENAME TO "Collection";
CREATE UNIQUE INDEX "Collection_slug_key" ON "Collection"("slug");
CREATE INDEX "Collection_isActive_position_idx" ON "Collection"("isActive", "position");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SearchDocument_entityType_isActive_idx" ON "SearchDocument"("entityType", "isActive");

-- CreateIndex
CREATE INDEX "SearchDocument_slug_idx" ON "SearchDocument"("slug");

-- CreateIndex
CREATE INDEX "SearchDocument_popularityScore_idx" ON "SearchDocument"("popularityScore");

-- CreateIndex
CREATE INDEX "SearchDocument_minPricePaise_idx" ON "SearchDocument"("minPricePaise");

-- CreateIndex
CREATE UNIQUE INDEX "SearchDocument_entityType_entityId_locale_key" ON "SearchDocument"("entityType", "entityId", "locale");

-- CreateIndex
CREATE INDEX "SearchQueryLog_normalizedQuery_createdAt_idx" ON "SearchQueryLog"("normalizedQuery", "createdAt");

-- CreateIndex
CREATE INDEX "SearchQueryLog_hasResults_createdAt_idx" ON "SearchQueryLog"("hasResults", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductStat_productId_key" ON "ProductStat"("productId");

-- CreateIndex
CREATE INDEX "ProductStat_popularityScore_idx" ON "ProductStat"("popularityScore");

-- CreateIndex
CREATE INDEX "SearchIndexJob_status_createdAt_idx" ON "SearchIndexJob"("status", "createdAt");
