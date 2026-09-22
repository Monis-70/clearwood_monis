-- CreateTable
CREATE TABLE "OrderSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Order" (
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

-- CreateTable
CREATE TABLE "OrderItem" (
    "orderId" TEXT NOT NULL,
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "variantName" TEXT,
    "brandName" TEXT,
    "primaryCategoryPath" TEXT,
    "imageMediaId" TEXT,
    "imageUrlSnapshot" TEXT,
    "selectedOptionsJson" TEXT,
    "optionLabelsJson" TEXT,
    "customizationJson" TEXT,
    "customizationHash" TEXT,
    "qty" INTEGER NOT NULL,
    "unitPricePaise" INTEGER NOT NULL,
    "baseUnitPricePaise" INTEGER NOT NULL,
    "lineSubtotalPaise" INTEGER NOT NULL,
    "lineDiscountPaise" INTEGER NOT NULL DEFAULT 0,
    "taxablePaise" INTEGER NOT NULL,
    "taxPaise" INTEGER NOT NULL,
    "taxRateBp" INTEGER NOT NULL DEFAULT 0,
    "cgstPaise" INTEGER NOT NULL DEFAULT 0,
    "sgstPaise" INTEGER NOT NULL DEFAULT 0,
    "igstPaise" INTEGER NOT NULL DEFAULT 0,
    "hsnCode" TEXT,
    "lineTotalPaise" INTEGER NOT NULL,
    "componentsJson" TEXT NOT NULL,
    "isMadeToOrder" BOOLEAN NOT NULL DEFAULT false,
    "leadTimeDays" INTEGER,
    "weightGrams" INTEGER,
    "fulfilledQty" INTEGER NOT NULL DEFAULT 0,
    "cancelledQty" INTEGER NOT NULL DEFAULT 0,
    "refundedQty" INTEGER NOT NULL DEFAULT 0,
    "refundedAmountPaise" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderAddress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sourceAddressId" TEXT,
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
    "deliveryInstructions" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderAddress_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderStatusHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "note" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "actorName" TEXT,
    "metaJson" TEXT,
    "isCustomerVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "method" TEXT,
    "methodDetail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "amountPaise" INTEGER NOT NULL,
    "capturedPaise" INTEGER NOT NULL DEFAULT 0,
    "refundedPaise" INTEGER NOT NULL DEFAULT 0,
    "feePaise" INTEGER,
    "taxOnFeePaise" INTEGER,
    "providerOrderId" TEXT,
    "providerPaymentId" TEXT,
    "providerSignature" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "authorizedAt" DATETIME,
    "capturedAt" DATETIME,
    "failedAt" DATETIME,
    "errorCode" TEXT,
    "errorDescription" TEXT,
    "errorSource" TEXT,
    "errorStep" TEXT,
    "errorReason" TEXT,
    "isTransferable" BOOLEAN NOT NULL DEFAULT true,
    "idempotencyKey" TEXT,
    "rawResponseJson" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SplitAccount" (
    "key" TEXT NOT NULL,
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SplitRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "scopeEntityId" TEXT,
    "basis" TEXT NOT NULL DEFAULT 'ORDER_TOTAL',
    "mode" TEXT NOT NULL,
    "valuePaise" INTEGER,
    "valueBp" INTEGER,
    "recipientKey" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "minOrderPaise" INTEGER,
    "maxTransferPaise" INTEGER,
    "onHold" BOOLEAN NOT NULL DEFAULT false,
    "onHoldUntil" DATETIME,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SplitAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT,
    "splitAccountId" TEXT NOT NULL,
    "splitRuleId" TEXT,
    "orderItemId" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "basisAmountPaise" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "isRemainder" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "computedAtHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SplitAllocation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SplitAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SplitAllocation_splitAccountId_fkey" FOREIGN KEY ("splitAccountId") REFERENCES "SplitAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SplitAllocation_splitRuleId_fkey" FOREIGN KEY ("splitRuleId") REFERENCES "SplitRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentTransfer" (
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

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "refundNumber" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "reasonNote" TEXT,
    "speed" TEXT NOT NULL DEFAULT 'NORMAL',
    "providerRefundId" TEXT,
    "isFullRefund" BOOLEAN NOT NULL DEFAULT false,
    "requestedById" TEXT,
    "requestedByType" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "processedAt" DATETIME,
    "failedAt" DATETIME,
    "errorCode" TEXT,
    "errorDescription" TEXT,
    "restockRequested" BOOLEAN NOT NULL DEFAULT true,
    "restockedAt" DATETIME,
    "rawResponseJson" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RefundItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "refundId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "taxPaise" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "RefundItem_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RefundItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TransferReversal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentTransferId" TEXT NOT NULL,
    "refundId" TEXT,
    "providerReversalId" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "processedAt" DATETIME,
    "errorCode" TEXT,
    "errorDescription" TEXT,
    "rawResponseJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransferReversal_paymentTransferId_fkey" FOREIGN KEY ("paymentTransferId") REFERENCES "PaymentTransfer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TransferReversal_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "providerSettlementId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "feePaise" INTEGER NOT NULL DEFAULT 0,
    "taxPaise" INTEGER NOT NULL DEFAULT 0,
    "utr" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "settledAt" DATETIME,
    "rawResponseJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SettlementEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "settlementId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "feePaise" INTEGER,
    "taxPaise" INTEGER,
    CONSTRAINT "SettlementEntry_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payloadJson" TEXT NOT NULL,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    "errorMessage" TEXT,
    "processingLockedAt" DATETIME
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "variantId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "reservedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "releasedAt" DATETIME,
    "releaseReason" TEXT,
    "inventoryLedgerIdOnConsume" TEXT,
    CONSTRAINT "StockReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockReservation_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cartId" TEXT NOT NULL,
    "customerId" TEXT,
    "sessionId" TEXT,
    "step" TEXT NOT NULL DEFAULT 'CART',
    "orderId" TEXT,
    "shippingAddressId" TEXT,
    "billingAddressId" TEXT,
    "sameAsShipping" BOOLEAN NOT NULL DEFAULT true,
    "addressesJson" TEXT,
    "paymentProvider" TEXT,
    "paymentMethodHint" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "customerNote" TEXT,
    "giftMessage" TEXT,
    "quoteHash" TEXT NOT NULL,
    "quotedTotalPaise" INTEGER NOT NULL,
    "quotedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderSequence_key_key" ON "OrderSequence"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_paymentStatus_idx" ON "Order"("paymentStatus");

-- CreateIndex
CREATE INDEX "Order_orderNumber_idx" ON "Order"("orderNumber");

-- CreateIndex
CREATE INDEX "Order_status_expiresAt_idx" ON "Order"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAddress_orderId_type_key" ON "OrderAddress"("orderId", "type");

-- CreateIndex
CREATE INDEX "OrderStatusHistory_orderId_createdAt_idx" ON "OrderStatusHistory"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_orderId_attemptNumber_idx" ON "Payment"("orderId", "attemptNumber");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerPaymentId_key" ON "Payment"("provider", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "SplitAccount_key_key" ON "SplitAccount"("key");

-- CreateIndex
CREATE UNIQUE INDEX "SplitRule_code_key" ON "SplitRule"("code");

-- CreateIndex
CREATE INDEX "SplitRule_scope_isActive_priority_idx" ON "SplitRule"("scope", "isActive", "priority");

-- CreateIndex
CREATE INDEX "SplitAllocation_orderId_idx" ON "SplitAllocation"("orderId");

-- CreateIndex
CREATE INDEX "SplitAllocation_paymentId_idx" ON "SplitAllocation"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransfer_splitAllocationId_key" ON "PaymentTransfer"("splitAllocationId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransfer_providerTransferId_key" ON "PaymentTransfer"("providerTransferId");

-- CreateIndex
CREATE INDEX "PaymentTransfer_paymentId_idx" ON "PaymentTransfer"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentTransfer_status_idx" ON "PaymentTransfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_refundNumber_key" ON "Refund"("refundNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_providerRefundId_key" ON "Refund"("providerRefundId");

-- CreateIndex
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- CreateIndex
CREATE INDEX "RefundItem_refundId_idx" ON "RefundItem"("refundId");

-- CreateIndex
CREATE UNIQUE INDEX "TransferReversal_providerReversalId_key" ON "TransferReversal"("providerReversalId");

-- CreateIndex
CREATE INDEX "TransferReversal_paymentTransferId_idx" ON "TransferReversal"("paymentTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_providerSettlementId_key" ON "Settlement"("providerSettlementId");

-- CreateIndex
CREATE INDEX "Settlement_status_idx" ON "Settlement"("status");

-- CreateIndex
CREATE INDEX "SettlementEntry_settlementId_idx" ON "SettlementEntry"("settlementId");

-- CreateIndex
CREATE INDEX "SettlementEntry_entityType_entityId_idx" ON "SettlementEntry"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_eventType_idx" ON "WebhookEvent"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_providerEventId_key" ON "WebhookEvent"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "StockReservation_orderId_idx" ON "StockReservation"("orderId");

-- CreateIndex
CREATE INDEX "StockReservation_variantId_status_idx" ON "StockReservation"("variantId", "status");

-- CreateIndex
CREATE INDEX "StockReservation_status_expiresAt_idx" ON "StockReservation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CheckoutSession_cartId_idx" ON "CheckoutSession"("cartId");

-- CreateIndex
CREATE INDEX "CheckoutSession_status_expiresAt_idx" ON "CheckoutSession"("status", "expiresAt");
