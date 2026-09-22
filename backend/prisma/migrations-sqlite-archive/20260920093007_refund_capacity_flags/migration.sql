-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Refund" (
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
    "clientReference" TEXT,
    "executionLockedAt" DATETIME,
    "executionAttempt" INTEGER NOT NULL DEFAULT 0,
    "capacityReserved" BOOLEAN NOT NULL DEFAULT false,
    "capacityConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "reversalStrategy" TEXT NOT NULL DEFAULT 'EXPLICIT',
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
INSERT INTO "new_Refund" ("amountPaise", "approvedAt", "approvedById", "clientReference", "createdAt", "errorCode", "errorDescription", "executionAttempt", "executionLockedAt", "failedAt", "id", "isFullRefund", "orderId", "paymentId", "processedAt", "providerRefundId", "rawResponseJson", "reason", "reasonNote", "refundNumber", "requestedById", "requestedByType", "restockRequested", "restockedAt", "reversalStrategy", "speed", "status", "updatedAt", "version") SELECT "amountPaise", "approvedAt", "approvedById", "clientReference", "createdAt", "errorCode", "errorDescription", "executionAttempt", "executionLockedAt", "failedAt", "id", "isFullRefund", "orderId", "paymentId", "processedAt", "providerRefundId", "rawResponseJson", "reason", "reasonNote", "refundNumber", "requestedById", "requestedByType", "restockRequested", "restockedAt", "reversalStrategy", "speed", "status", "updatedAt", "version" FROM "Refund";
DROP TABLE "Refund";
ALTER TABLE "new_Refund" RENAME TO "Refund";
CREATE UNIQUE INDEX "Refund_refundNumber_key" ON "Refund"("refundNumber");
CREATE UNIQUE INDEX "Refund_providerRefundId_key" ON "Refund"("providerRefundId");
CREATE UNIQUE INDEX "Refund_clientReference_key" ON "Refund"("clientReference");
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");
CREATE INDEX "Refund_status_idx" ON "Refund"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
