-- AlterTable
ALTER TABLE "Product" ADD COLUMN "priceNote" TEXT;

-- CreateTable
CREATE TABLE "CustomerGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "discountBp" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "CustomerGroupMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CustomerGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceList" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerGroupId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'WEB',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "PriceList_customerGroupId_fkey" FOREIGN KEY ("customerGroupId") REFERENCES "CustomerGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceListItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "priceListId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "minQty" INTEGER NOT NULL DEFAULT 1,
    "pricePaise" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PriceListItem_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TierPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT,
    "variantId" TEXT,
    "customerGroupId" TEXT,
    "minQty" INTEGER NOT NULL,
    "pricePaise" INTEGER,
    "discountBp" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "TierPrice_customerGroupId_fkey" FOREIGN KEY ("customerGroupId") REFERENCES "CustomerGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "valueBp" INTEGER,
    "valuePaise" INTEGER,
    "minSubtotalPaise" INTEGER,
    "maxDiscountPaise" INTEGER,
    "usageLimit" INTEGER,
    "perCustomerLimit" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isStackable" BOOLEAN NOT NULL DEFAULT false,
    "isAutoApply" BOOLEAN NOT NULL DEFAULT false,
    "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
    "appliesToJson" TEXT,
    "description" TEXT,
    "termsText" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "couponId" TEXT NOT NULL,
    "customerId" TEXT,
    "orderId" TEXT,
    "amountPaise" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "reservedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" DATETIME,
    "releasedAt" DATETIME,
    CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DiscountRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "stopFurtherRules" BOOLEAN NOT NULL DEFAULT false,
    "conditionsJson" TEXT NOT NULL,
    "actionsJson" TEXT NOT NULL,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "usageLimit" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ShippingZone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ShippingPincode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "zoneId" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "stateCode" TEXT,
    "isServiceable" BOOLEAN NOT NULL DEFAULT true,
    "codAvailable" BOOLEAN NOT NULL DEFAULT false,
    "etaMinDays" INTEGER,
    "etaMaxDays" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShippingPincode_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "ShippingZone" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShippingPincodeRange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "zoneId" TEXT NOT NULL,
    "fromPincode" TEXT NOT NULL,
    "toPincode" TEXT NOT NULL,
    "stateCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShippingPincodeRange_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "ShippingZone" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShippingRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "zoneId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conditionType" TEXT NOT NULL,
    "minValue" INTEGER,
    "maxValue" INTEGER,
    "basePaise" INTEGER NOT NULL,
    "perUnitPaise" INTEGER,
    "freeAbovePaise" INTEGER,
    "etaMinDays" INTEGER,
    "etaMaxDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ShippingRate_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "ShippingZone" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "customerGroupId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'ALL',
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
INSERT INTO "new_PriceAdjustment" ("adjustmentType", "attributeId", "attributeValueId", "basis", "categoryId", "conditionsJson", "createdAt", "deletedAt", "endsAt", "id", "isActive", "maxQty", "minQty", "name", "note", "priority", "productId", "scope", "startsAt", "updatedAt", "valueBp", "valuePaise", "variantId", "version") SELECT "adjustmentType", "attributeId", "attributeValueId", "basis", "categoryId", "conditionsJson", "createdAt", "deletedAt", "endsAt", "id", "isActive", "maxQty", "minQty", "name", "note", "priority", "productId", "scope", "startsAt", "updatedAt", "valueBp", "valuePaise", "variantId", "version" FROM "PriceAdjustment";
DROP TABLE "PriceAdjustment";
ALTER TABLE "new_PriceAdjustment" RENAME TO "PriceAdjustment";
CREATE INDEX "PriceAdjustment_scope_isActive_priority_idx" ON "PriceAdjustment"("scope", "isActive", "priority");
CREATE INDEX "PriceAdjustment_productId_idx" ON "PriceAdjustment"("productId");
CREATE INDEX "PriceAdjustment_attributeValueId_idx" ON "PriceAdjustment"("attributeValueId");
CREATE INDEX "PriceAdjustment_customerGroupId_idx" ON "PriceAdjustment"("customerGroupId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CustomerGroup_code_key" ON "CustomerGroup"("code");

-- CreateIndex
CREATE INDEX "CustomerGroup_isActive_priority_idx" ON "CustomerGroup"("isActive", "priority");

-- CreateIndex
CREATE INDEX "CustomerGroupMember_groupId_idx" ON "CustomerGroupMember"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerGroupMember_customerId_groupId_key" ON "CustomerGroupMember"("customerId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceList_code_key" ON "PriceList"("code");

-- CreateIndex
CREATE INDEX "PriceList_isActive_priority_idx" ON "PriceList"("isActive", "priority");

-- CreateIndex
CREATE INDEX "PriceListItem_productId_idx" ON "PriceListItem"("productId");

-- CreateIndex
CREATE INDEX "PriceListItem_variantId_idx" ON "PriceListItem"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListItem_priceListId_productId_variantId_minQty_key" ON "PriceListItem"("priceListId", "productId", "variantId", "minQty");

-- CreateIndex
CREATE INDEX "TierPrice_productId_minQty_idx" ON "TierPrice"("productId", "minQty");

-- CreateIndex
CREATE INDEX "TierPrice_variantId_minQty_idx" ON "TierPrice"("variantId", "minQty");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "Coupon_isActive_startsAt_endsAt_idx" ON "Coupon"("isActive", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "Coupon_isAutoApply_isActive_idx" ON "Coupon"("isAutoApply", "isActive");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_customerId_idx" ON "CouponRedemption"("couponId", "customerId");

-- CreateIndex
CREATE INDEX "CouponRedemption_status_idx" ON "CouponRedemption"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_couponId_orderId_key" ON "CouponRedemption"("couponId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountRule_code_key" ON "DiscountRule"("code");

-- CreateIndex
CREATE INDEX "DiscountRule_isActive_scope_priority_idx" ON "DiscountRule"("isActive", "scope", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingZone_code_key" ON "ShippingZone"("code");

-- CreateIndex
CREATE INDEX "ShippingZone_isActive_priority_idx" ON "ShippingZone"("isActive", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingPincode_pincode_key" ON "ShippingPincode"("pincode");

-- CreateIndex
CREATE INDEX "ShippingPincode_zoneId_idx" ON "ShippingPincode"("zoneId");

-- CreateIndex
CREATE INDEX "ShippingPincodeRange_zoneId_idx" ON "ShippingPincodeRange"("zoneId");

-- CreateIndex
CREATE INDEX "ShippingPincodeRange_fromPincode_toPincode_idx" ON "ShippingPincodeRange"("fromPincode", "toPincode");

-- CreateIndex
CREATE INDEX "ShippingRate_zoneId_method_priority_idx" ON "ShippingRate"("zoneId", "method", "priority");
