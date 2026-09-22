-- CreateTable
CREATE TABLE "SlugRedirect" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "fromSlug" TEXT NOT NULL,
    "toSlug" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 301,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "InventoryLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "variantId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "note" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryLedger_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductRelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "relatedProductId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductRelation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductRelation_relatedProductId_fkey" FOREIGN KEY ("relatedProductId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fileName" TEXT NOT NULL,
    "mediaId" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "successRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "errorsJson" TEXT,
    "summaryJson" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "principalType" TEXT NOT NULL,
    "principalId" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "responseStatus" INTEGER,
    "responseJson" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Attribute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "groupId" TEXT,
    "inputType" TEXT NOT NULL,
    "dataType" TEXT NOT NULL DEFAULT 'STRING',
    "unit" TEXT,
    "isVariantDefining" BOOLEAN NOT NULL DEFAULT false,
    "isFilterable" BOOLEAN NOT NULL DEFAULT true,
    "isSearchable" BOOLEAN NOT NULL DEFAULT false,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isComparable" BOOLEAN NOT NULL DEFAULT false,
    "showInSwatch" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "helpText" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Attribute_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AttributeGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Attribute" ("code", "createdAt", "dataType", "deletedAt", "groupId", "helpText", "id", "inputType", "isActive", "isComparable", "isFilterable", "isRequired", "isSearchable", "isVariantDefining", "name", "position", "showInSwatch", "unit", "updatedAt") SELECT "code", "createdAt", "dataType", "deletedAt", "groupId", "helpText", "id", "inputType", "isActive", "isComparable", "isFilterable", "isRequired", "isSearchable", "isVariantDefining", "name", "position", "showInSwatch", "unit", "updatedAt" FROM "Attribute";
DROP TABLE "Attribute";
ALTER TABLE "new_Attribute" RENAME TO "Attribute";
CREATE UNIQUE INDEX "Attribute_code_key" ON "Attribute"("code");
CREATE INDEX "Attribute_groupId_position_idx" ON "Attribute"("groupId", "position");
CREATE INDEX "Attribute_isFilterable_idx" ON "Attribute"("isFilterable");
CREATE TABLE "new_AttributeValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attributeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "colorHex" TEXT,
    "swatchMediaId" TEXT,
    "numericValue" INTEGER,
    "metaJson" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "AttributeValue_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "Attribute" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AttributeValue" ("attributeId", "code", "colorHex", "createdAt", "deletedAt", "id", "isActive", "label", "metaJson", "numericValue", "position", "swatchMediaId", "updatedAt") SELECT "attributeId", "code", "colorHex", "createdAt", "deletedAt", "id", "isActive", "label", "metaJson", "numericValue", "position", "swatchMediaId", "updatedAt" FROM "AttributeValue";
DROP TABLE "AttributeValue";
ALTER TABLE "new_AttributeValue" RENAME TO "AttributeValue";
CREATE INDEX "AttributeValue_attributeId_position_idx" ON "AttributeValue"("attributeId", "position");
CREATE UNIQUE INDEX "AttributeValue_attributeId_code_key" ON "AttributeValue"("attributeId", "code");
CREATE TABLE "new_Brand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoMediaId" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);
INSERT INTO "new_Brand" ("createdAt", "deletedAt", "description", "id", "isActive", "logoMediaId", "name", "position", "slug", "updatedAt") SELECT "createdAt", "deletedAt", "description", "id", "isActive", "logoMediaId", "name", "position", "slug", "updatedAt" FROM "Brand";
DROP TABLE "Brand";
ALTER TABLE "new_Brand" RENAME TO "Brand";
CREATE UNIQUE INDEX "Brand_slug_key" ON "Brand"("slug");
CREATE INDEX "Brand_isActive_position_idx" ON "Brand"("isActive", "position");
CREATE TABLE "new_Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'STANDARD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "showInMenu" BOOLEAN NOT NULL DEFAULT true,
    "menuColumn" INTEGER,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "shortDescription" TEXT,
    "description" TEXT,
    "iconMediaId" TEXT,
    "bannerMediaId" TEXT,
    "mobileBannerMediaId" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "seoKeywords" TEXT,
    "productCountCache" INTEGER NOT NULL DEFAULT 0,
    "deleteStrategyNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Category" ("bannerMediaId", "createdAt", "deletedAt", "depth", "description", "iconMediaId", "id", "isActive", "isFeatured", "kind", "menuColumn", "mobileBannerMediaId", "name", "parentId", "path", "position", "productCountCache", "seoDescription", "seoKeywords", "seoTitle", "shortDescription", "showInMenu", "slug", "updatedAt") SELECT "bannerMediaId", "createdAt", "deletedAt", "depth", "description", "iconMediaId", "id", "isActive", "isFeatured", "kind", "menuColumn", "mobileBannerMediaId", "name", "parentId", "path", "position", "productCountCache", "seoDescription", "seoKeywords", "seoTitle", "shortDescription", "showInMenu", "slug", "updatedAt" FROM "Category";
DROP TABLE "Category";
ALTER TABLE "new_Category" RENAME TO "Category";
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");
CREATE INDEX "Category_parentId_position_idx" ON "Category"("parentId", "position");
CREATE INDEX "Category_path_idx" ON "Category"("path");
CREATE INDEX "Category_isActive_showInMenu_idx" ON "Category"("isActive", "showInMenu");
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
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);
INSERT INTO "new_Collection" ("bannerMediaId", "createdAt", "deletedAt", "description", "endsAt", "id", "isActive", "mobileBannerMediaId", "name", "position", "rulesJson", "seoDescription", "seoTitle", "slug", "startsAt", "type", "updatedAt") SELECT "bannerMediaId", "createdAt", "deletedAt", "description", "endsAt", "id", "isActive", "mobileBannerMediaId", "name", "position", "rulesJson", "seoDescription", "seoTitle", "slug", "startsAt", "type", "updatedAt" FROM "Collection";
DROP TABLE "Collection";
ALTER TABLE "new_Collection" RENAME TO "Collection";
CREATE UNIQUE INDEX "Collection_slug_key" ON "Collection"("slug");
CREATE INDEX "Collection_isActive_position_idx" ON "Collection"("isActive", "position");
CREATE TABLE "new_PriceAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "adjustmentType" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'BASE',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "valuePaise" INTEGER,
    "valueBp" INTEGER,
    "categoryId" TEXT,
    "productId" TEXT,
    "variantId" TEXT,
    "attributeId" TEXT,
    "attributeValueId" TEXT,
    "minQty" INTEGER,
    "maxQty" INTEGER,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "conditionsJson" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);
INSERT INTO "new_PriceAdjustment" ("adjustmentType", "attributeId", "attributeValueId", "basis", "categoryId", "conditionsJson", "createdAt", "deletedAt", "endsAt", "id", "isActive", "maxQty", "minQty", "name", "note", "priority", "productId", "scope", "startsAt", "updatedAt", "valueBp", "valuePaise", "variantId") SELECT "adjustmentType", "attributeId", "attributeValueId", "basis", "categoryId", "conditionsJson", "createdAt", "deletedAt", "endsAt", "id", "isActive", "maxQty", "minQty", "name", "note", "priority", "productId", "scope", "startsAt", "updatedAt", "valueBp", "valuePaise", "variantId" FROM "PriceAdjustment";
DROP TABLE "PriceAdjustment";
ALTER TABLE "new_PriceAdjustment" RENAME TO "PriceAdjustment";
CREATE INDEX "PriceAdjustment_scope_isActive_priority_idx" ON "PriceAdjustment"("scope", "isActive", "priority");
CREATE INDEX "PriceAdjustment_productId_idx" ON "PriceAdjustment"("productId");
CREATE INDEX "PriceAdjustment_attributeValueId_idx" ON "PriceAdjustment"("attributeValueId");
CREATE TABLE "new_Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subtitle" TEXT,
    "shortDescription" TEXT,
    "description" TEXT,
    "productType" TEXT NOT NULL DEFAULT 'SIMPLE',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "brandId" TEXT,
    "taxClassId" TEXT,
    "basePricePaise" INTEGER NOT NULL DEFAULT 0,
    "compareAtPricePaise" INTEGER,
    "costPricePaise" INTEGER,
    "isMadeToOrder" BOOLEAN NOT NULL DEFAULT false,
    "leadTimeDays" INTEGER,
    "allowCustomization" BOOLEAN NOT NULL DEFAULT false,
    "manufacturedInHouse" BOOLEAN NOT NULL DEFAULT true,
    "manufacturingNote" TEXT,
    "warrantyMonths" INTEGER,
    "careInstructions" TEXT,
    "assemblyRequired" BOOLEAN NOT NULL DEFAULT false,
    "weightGrams" INTEGER,
    "lengthMm" INTEGER,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "seatHeightMm" INTEGER,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "isNewArrival" BOOLEAN NOT NULL DEFAULT false,
    "isSpecialCollection" BOOLEAN NOT NULL DEFAULT false,
    "isBestSeller" BOOLEAN NOT NULL DEFAULT false,
    "minOrderQty" INTEGER NOT NULL DEFAULT 1,
    "maxOrderQty" INTEGER,
    "ratingAvgBp" INTEGER NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "soldCount" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" DATETIME,
    "lastPublishedAt" DATETIME,
    "completenessScore" INTEGER NOT NULL DEFAULT 0,
    "publishBlockersJson" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "seoKeywords" TEXT,
    "searchKeywords" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Product_taxClassId_fkey" FOREIGN KEY ("taxClassId") REFERENCES "TaxClass" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Product" ("allowCustomization", "assemblyRequired", "basePricePaise", "brandId", "careInstructions", "compareAtPricePaise", "costPricePaise", "createdAt", "deletedAt", "description", "heightMm", "id", "isBestSeller", "isFeatured", "isMadeToOrder", "isNewArrival", "isSpecialCollection", "leadTimeDays", "lengthMm", "manufacturedInHouse", "manufacturingNote", "maxOrderQty", "minOrderQty", "name", "position", "productType", "publishedAt", "ratingAvgBp", "ratingCount", "searchKeywords", "seatHeightMm", "seoDescription", "seoKeywords", "seoTitle", "shortDescription", "sku", "slug", "soldCount", "status", "subtitle", "taxClassId", "updatedAt", "visibility", "warrantyMonths", "weightGrams", "widthMm") SELECT "allowCustomization", "assemblyRequired", "basePricePaise", "brandId", "careInstructions", "compareAtPricePaise", "costPricePaise", "createdAt", "deletedAt", "description", "heightMm", "id", "isBestSeller", "isFeatured", "isMadeToOrder", "isNewArrival", "isSpecialCollection", "leadTimeDays", "lengthMm", "manufacturedInHouse", "manufacturingNote", "maxOrderQty", "minOrderQty", "name", "position", "productType", "publishedAt", "ratingAvgBp", "ratingCount", "searchKeywords", "seatHeightMm", "seoDescription", "seoKeywords", "seoTitle", "shortDescription", "sku", "slug", "soldCount", "status", "subtitle", "taxClassId", "updatedAt", "visibility", "warrantyMonths", "weightGrams", "widthMm" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");
CREATE INDEX "Product_status_publishedAt_idx" ON "Product"("status", "publishedAt");
CREATE INDEX "Product_isNewArrival_idx" ON "Product"("isNewArrival");
CREATE INDEX "Product_isFeatured_idx" ON "Product"("isFeatured");
CREATE INDEX "Product_basePricePaise_idx" ON "Product"("basePricePaise");
CREATE INDEX "Product_completenessScore_idx" ON "Product"("completenessScore");
CREATE TABLE "new_ProductVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT,
    "pricePaise" INTEGER,
    "compareAtPricePaise" INTEGER,
    "costPricePaise" INTEGER,
    "weightGrams" INTEGER,
    "barcode" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "stockQty" INTEGER NOT NULL DEFAULT 0,
    "reservedQty" INTEGER NOT NULL DEFAULT 0,
    "stockStatus" TEXT NOT NULL DEFAULT 'IN_STOCK',
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 0,
    "allowBackorder" BOOLEAN NOT NULL DEFAULT false,
    "leadTimeDays" INTEGER,
    "lengthMm" INTEGER,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ProductVariant" ("allowBackorder", "barcode", "compareAtPricePaise", "costPricePaise", "createdAt", "deletedAt", "heightMm", "id", "isActive", "isDefault", "leadTimeDays", "lengthMm", "lowStockThreshold", "name", "position", "pricePaise", "productId", "sku", "stockQty", "stockStatus", "updatedAt", "weightGrams", "widthMm") SELECT "allowBackorder", "barcode", "compareAtPricePaise", "costPricePaise", "createdAt", "deletedAt", "heightMm", "id", "isActive", "isDefault", "leadTimeDays", "lengthMm", "lowStockThreshold", "name", "position", "pricePaise", "productId", "sku", "stockQty", "stockStatus", "updatedAt", "weightGrams", "widthMm" FROM "ProductVariant";
DROP TABLE "ProductVariant";
ALTER TABLE "new_ProductVariant" RENAME TO "ProductVariant";
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");
CREATE INDEX "ProductVariant_productId_position_idx" ON "ProductVariant"("productId", "position");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SlugRedirect_entityId_idx" ON "SlugRedirect"("entityId");

-- CreateIndex
CREATE INDEX "SlugRedirect_entityType_toSlug_idx" ON "SlugRedirect"("entityType", "toSlug");

-- CreateIndex
CREATE UNIQUE INDEX "SlugRedirect_entityType_fromSlug_key" ON "SlugRedirect"("entityType", "fromSlug");

-- CreateIndex
CREATE INDEX "InventoryLedger_variantId_createdAt_idx" ON "InventoryLedger"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryLedger_reason_createdAt_idx" ON "InventoryLedger"("reason", "createdAt");

-- CreateIndex
CREATE INDEX "ProductRelation_relatedProductId_idx" ON "ProductRelation"("relatedProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRelation_productId_relatedProductId_type_key" ON "ProductRelation"("productId", "relatedProductId", "type");

-- CreateIndex
CREATE INDEX "ImportJob_entity_status_idx" ON "ImportJob"("entity", "status");

-- CreateIndex
CREATE INDEX "ImportJob_createdAt_idx" ON "ImportJob"("createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_scope_key_key" ON "IdempotencyKey"("scope", "key");
