-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ReturnItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "returnRequestId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "qtyRequested" INTEGER NOT NULL,
    "qtyApproved" INTEGER NOT NULL DEFAULT 0,
    "qtyReceived" INTEGER NOT NULL DEFAULT 0,
    "qtyRestocked" INTEGER NOT NULL DEFAULT 0,
    "condition" TEXT NOT NULL DEFAULT 'PENDING',
    "inspectionNote" TEXT,
    "restockRequested" BOOLEAN NOT NULL DEFAULT false,
    "unitPricePaise" INTEGER NOT NULL,
    "refundableAmountPaise" INTEGER NOT NULL DEFAULT 0,
    "refundableTaxPaise" INTEGER NOT NULL DEFAULT 0,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "variantName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReturnItem_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReturnItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ReturnItem" ("condition", "createdAt", "id", "inspectionNote", "orderItemId", "productName", "qtyApproved", "qtyReceived", "qtyRequested", "qtyRestocked", "refundableAmountPaise", "refundableTaxPaise", "returnRequestId", "sku", "unitPricePaise", "updatedAt", "variantName") SELECT "condition", "createdAt", "id", "inspectionNote", "orderItemId", "productName", "qtyApproved", "qtyReceived", "qtyRequested", "qtyRestocked", "refundableAmountPaise", "refundableTaxPaise", "returnRequestId", "sku", "unitPricePaise", "updatedAt", "variantName" FROM "ReturnItem";
DROP TABLE "ReturnItem";
ALTER TABLE "new_ReturnItem" RENAME TO "ReturnItem";
CREATE INDEX "ReturnItem_orderItemId_idx" ON "ReturnItem"("orderItemId");
CREATE UNIQUE INDEX "ReturnItem_returnRequestId_orderItemId_key" ON "ReturnItem"("returnRequestId", "orderItemId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
