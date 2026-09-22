/*
  Warnings:

  - A unique constraint covering the columns `[refundId]` on the table `OrderDocument` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "OrderDocument" ADD COLUMN "refundId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "OrderDocument_refundId_key" ON "OrderDocument"("refundId");
