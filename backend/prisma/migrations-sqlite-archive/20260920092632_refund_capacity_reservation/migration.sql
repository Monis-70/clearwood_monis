-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderNumber" TEXT NOT NULL,
    "customerId" TEXT,
    "cartId" TEXT,
    "isGuest" BOOLEAN NOT NULL DEFAULT false,
    "guestEmail" TEXT,
    "guestPhone" TEXT,
    "guestName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "fulfillmentStatus" TEXT NOT NULL DEFAULT 'UNFULFILLED',
    "channel" TEXT NOT NULL DEFAULT 'WEB',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "customerGroupCode" TEXT,
    "placeOfSupply" TEXT NOT NULL,
    "sellerStateCode" TEXT NOT NULL,
    "subtotalPaise" INTEGER NOT NULL,
    "discountPaise" INTEGER NOT NULL,
    "shippingPaise" INTEGER NOT NULL,
    "taxPaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL DEFAULT 0,
    "sgstPaise" INTEGER NOT NULL DEFAULT 0,
    "igstPaise" INTEGER NOT NULL DEFAULT 0,
    "roundingPaise" INTEGER NOT NULL DEFAULT 0,
    "grandTotalPaise" INTEGER NOT NULL,
    "totalSavingsPaise" INTEGER NOT NULL DEFAULT 0,
    "paidPaise" INTEGER NOT NULL DEFAULT 0,
    "refundedPaise" INTEGER NOT NULL DEFAULT 0,
    "refundReservedPaise" INTEGER NOT NULL DEFAULT 0,
    "duePaise" INTEGER NOT NULL DEFAULT 0,
    "couponCode" TEXT,
    "appliedRuleIdsJson" TEXT,
    "breakdownJson" TEXT NOT NULL,
    "pricingEngineVersion" TEXT NOT NULL,
    "pricingContextHash" TEXT NOT NULL,
    "customerNote" TEXT,
    "internalNote" TEXT,
    "giftMessage" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "referrer" TEXT,
    "utmJson" TEXT,
    "placedAt" DATETIME,
    "confirmedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelReason" TEXT,
    "expiresAt" DATETIME,
    "estimatedDeliveryMinDays" INTEGER,
    "estimatedDeliveryMaxDays" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Order" ("appliedRuleIdsJson", "breakdownJson", "cancelReason", "cancelledAt", "cartId", "cgstPaise", "channel", "confirmedAt", "couponCode", "createdAt", "currency", "customerGroupCode", "customerId", "customerNote", "discountPaise", "duePaise", "estimatedDeliveryMaxDays", "estimatedDeliveryMinDays", "expiresAt", "fulfillmentStatus", "giftMessage", "grandTotalPaise", "guestEmail", "guestName", "guestPhone", "id", "igstPaise", "internalNote", "ipAddress", "isGuest", "orderNumber", "paidPaise", "paymentStatus", "placeOfSupply", "placedAt", "pricingContextHash", "pricingEngineVersion", "referrer", "refundedPaise", "roundingPaise", "sellerStateCode", "sgstPaise", "shippingPaise", "status", "subtotalPaise", "taxPaise", "totalSavingsPaise", "updatedAt", "userAgent", "utmJson", "version") SELECT "appliedRuleIdsJson", "breakdownJson", "cancelReason", "cancelledAt", "cartId", "cgstPaise", "channel", "confirmedAt", "couponCode", "createdAt", "currency", "customerGroupCode", "customerId", "customerNote", "discountPaise", "duePaise", "estimatedDeliveryMaxDays", "estimatedDeliveryMinDays", "expiresAt", "fulfillmentStatus", "giftMessage", "grandTotalPaise", "guestEmail", "guestName", "guestPhone", "id", "igstPaise", "internalNote", "ipAddress", "isGuest", "orderNumber", "paidPaise", "paymentStatus", "placeOfSupply", "placedAt", "pricingContextHash", "pricingEngineVersion", "referrer", "refundedPaise", "roundingPaise", "sellerStateCode", "sgstPaise", "shippingPaise", "status", "subtotalPaise", "taxPaise", "totalSavingsPaise", "updatedAt", "userAgent", "utmJson", "version" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");
CREATE INDEX "Order_paymentStatus_idx" ON "Order"("paymentStatus");
CREATE INDEX "Order_orderNumber_idx" ON "Order"("orderNumber");
CREATE INDEX "Order_status_expiresAt_idx" ON "Order"("status", "expiresAt");
CREATE TABLE "new_PaymentTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    "splitAllocationId" TEXT,
    "splitAccountId" TEXT NOT NULL,
    "providerTransferId" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "feePaise" INTEGER,
    "taxPaise" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "onHold" BOOLEAN NOT NULL DEFAULT false,
    "onHoldUntil" DATETIME,
    "reversedPaise" INTEGER NOT NULL DEFAULT 0,
    "reversalReservedPaise" INTEGER NOT NULL DEFAULT 0,
    "settlementStatus" TEXT,
    "providerRecipientId" TEXT NOT NULL,
    "notesJson" TEXT,
    "rawResponseJson" TEXT,
    "processedAt" DATETIME,
    "failedAt" DATETIME,
    "errorCode" TEXT,
    "errorDescription" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentTransfer_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaymentTransfer_splitAllocationId_fkey" FOREIGN KEY ("splitAllocationId") REFERENCES "SplitAllocation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PaymentTransfer_splitAccountId_fkey" FOREIGN KEY ("splitAccountId") REFERENCES "SplitAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PaymentTransfer" ("amountPaise", "createdAt", "errorCode", "errorDescription", "failedAt", "feePaise", "id", "notesJson", "onHold", "onHoldUntil", "paymentId", "processedAt", "providerRecipientId", "providerTransferId", "rawResponseJson", "reversedPaise", "settlementStatus", "splitAccountId", "splitAllocationId", "status", "taxPaise", "updatedAt") SELECT "amountPaise", "createdAt", "errorCode", "errorDescription", "failedAt", "feePaise", "id", "notesJson", "onHold", "onHoldUntil", "paymentId", "processedAt", "providerRecipientId", "providerTransferId", "rawResponseJson", "reversedPaise", "settlementStatus", "splitAccountId", "splitAllocationId", "status", "taxPaise", "updatedAt" FROM "PaymentTransfer";
DROP TABLE "PaymentTransfer";
ALTER TABLE "new_PaymentTransfer" RENAME TO "PaymentTransfer";
CREATE UNIQUE INDEX "PaymentTransfer_splitAllocationId_key" ON "PaymentTransfer"("splitAllocationId");
CREATE UNIQUE INDEX "PaymentTransfer_providerTransferId_key" ON "PaymentTransfer"("providerTransferId");
CREATE INDEX "PaymentTransfer_paymentId_idx" ON "PaymentTransfer"("paymentId");
CREATE INDEX "PaymentTransfer_status_idx" ON "PaymentTransfer"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
