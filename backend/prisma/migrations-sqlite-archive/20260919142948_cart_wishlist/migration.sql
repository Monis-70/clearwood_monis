-- CreateTable
CREATE TABLE "Cart" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT,
    "sessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "activeOwnerKey" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'WEB',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "couponCode" TEXT,
    "pincode" TEXT,
    "customerGroupIdSnapshot" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "quantityTotal" INTEGER NOT NULL DEFAULT 0,
    "lastQuotedTotalPaise" INTEGER,
    "lastQuoteContextHash" TEXT,
    "lastQuotedAt" DATETIME,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "mergedIntoCartId" TEXT,
    "convertedOrderId" TEXT,
    "notesJson" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CartItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cartId" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "selectedOptionsJson" TEXT,
    "customizationJson" TEXT,
    "customizationHash" TEXT,
    "saveState" TEXT NOT NULL DEFAULT 'IN_CART',
    "addedUnitPricePaise" INTEGER NOT NULL DEFAULT 0,
    "addedTotalPaise" INTEGER NOT NULL DEFAULT 0,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUnitPricePaise" INTEGER,
    "lastTotalPaise" INTEGER,
    "productNameSnapshot" TEXT NOT NULL,
    "variantNameSnapshot" TEXT,
    "skuSnapshot" TEXT NOT NULL,
    "imageMediaIdSnapshot" TEXT,
    "note" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CartItem_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CartEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cartId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CartEvent_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Wishlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT,
    "sessionId" TEXT,
    "name" TEXT NOT NULL DEFAULT 'My Wishlist',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "shareToken" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WishlistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "wishlistId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "selectedOptionsJson" TEXT,
    "lineKey" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "note" TEXT,
    "addedPricePaise" INTEGER NOT NULL DEFAULT 0,
    "lastSeenPricePaise" INTEGER,
    "priceDropNotifiedAt" DATETIME,
    "position" INTEGER NOT NULL DEFAULT 0,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WishlistItem_wishlistId_fkey" FOREIGN KEY ("wishlistId") REFERENCES "Wishlist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Address" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "label" TEXT,
    "type" TEXT NOT NULL DEFAULT 'HOME',
    "usage" TEXT NOT NULL DEFAULT 'BOTH',
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "altPhone" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "landmark" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "isDefaultShipping" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultBilling" BOOLEAN NOT NULL DEFAULT false,
    "deliveryInstructions" TEXT,
    "latitude" REAL,
    "longitude" REAL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Address_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecentlyViewed" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT,
    "sessionId" TEXT,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 1,
    "viewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT,
    "phone" TEXT,
    "name" TEXT,
    "passwordHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "emailVerifiedAt" DATETIME,
    "phoneVerifiedAt" DATETIME,
    "defaultAddressId" TEXT,
    "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "acceptsWhatsapp" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "avatarMediaId" TEXT,
    "referralCode" TEXT,
    "notesJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Customer_defaultAddressId_fkey" FOREIGN KEY ("defaultAddressId") REFERENCES "Address" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Customer" ("acceptsWhatsapp", "avatarMediaId", "createdAt", "defaultAddressId", "deletedAt", "email", "emailVerifiedAt", "failedLoginCount", "id", "lastLoginAt", "lockedUntil", "marketingOptIn", "name", "notesJson", "passwordHash", "phone", "phoneVerifiedAt", "referralCode", "status", "updatedAt") SELECT "acceptsWhatsapp", "avatarMediaId", "createdAt", "defaultAddressId", "deletedAt", "email", "emailVerifiedAt", "failedLoginCount", "id", "lastLoginAt", "lockedUntil", "marketingOptIn", "name", "notesJson", "passwordHash", "phone", "phoneVerifiedAt", "referralCode", "status", "updatedAt" FROM "Customer";
DROP TABLE "Customer";
ALTER TABLE "new_Customer" RENAME TO "Customer";
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");
CREATE UNIQUE INDEX "Customer_referralCode_key" ON "Customer"("referralCode");
CREATE INDEX "Customer_status_idx" ON "Customer"("status");
CREATE INDEX "Customer_defaultAddressId_idx" ON "Customer"("defaultAddressId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Cart_activeOwnerKey_key" ON "Cart"("activeOwnerKey");

-- CreateIndex
CREATE INDEX "Cart_customerId_status_idx" ON "Cart"("customerId", "status");

-- CreateIndex
CREATE INDEX "Cart_sessionId_status_idx" ON "Cart"("sessionId", "status");

-- CreateIndex
CREATE INDEX "Cart_status_lastActivityAt_idx" ON "Cart"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "CartItem_cartId_saveState_position_idx" ON "CartItem"("cartId", "saveState", "position");

-- CreateIndex
CREATE INDEX "CartItem_productId_idx" ON "CartItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_cartId_lineKey_key" ON "CartItem"("cartId", "lineKey");

-- CreateIndex
CREATE INDEX "CartEvent_cartId_createdAt_idx" ON "CartEvent"("cartId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Wishlist_shareToken_key" ON "Wishlist"("shareToken");

-- CreateIndex
CREATE INDEX "Wishlist_customerId_idx" ON "Wishlist"("customerId");

-- CreateIndex
CREATE INDEX "Wishlist_sessionId_idx" ON "Wishlist"("sessionId");

-- CreateIndex
CREATE INDEX "WishlistItem_productId_idx" ON "WishlistItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "WishlistItem_wishlistId_lineKey_key" ON "WishlistItem"("wishlistId", "lineKey");

-- CreateIndex
CREATE INDEX "Address_customerId_idx" ON "Address"("customerId");

-- CreateIndex
CREATE INDEX "Address_pincode_idx" ON "Address"("pincode");

-- CreateIndex
CREATE INDEX "RecentlyViewed_customerId_viewedAt_idx" ON "RecentlyViewed"("customerId", "viewedAt");

-- CreateIndex
CREATE INDEX "RecentlyViewed_sessionId_viewedAt_idx" ON "RecentlyViewed"("sessionId", "viewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecentlyViewed_customerId_productId_key" ON "RecentlyViewed"("customerId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "RecentlyViewed_sessionId_productId_key" ON "RecentlyViewed"("sessionId", "productId");
