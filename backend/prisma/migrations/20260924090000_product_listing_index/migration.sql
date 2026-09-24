-- Prompt 4: the catalog's own listing price index (docs/DB_MIGRATION_PLAN.md section 4b).
--
-- Until now the storefront filtered and sorted on SearchDocument.minPricePaise, which belongs to
-- the SQL search driver and would stop being written under any other driver. The rows below are
-- the same numbers (DEFAULT customer group, qty 1, from the pricing facade), copied once so the
-- listing keeps its price order across the deploy; every later write is by listingIndex.service.

-- CreateTable
CREATE TABLE `ProductListingIndex` (
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `minPricePaise` INTEGER NULL,
    `maxPricePaise` INTEGER NULL,
    `computedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProductListingIndex_productId_key`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProductListingIndex` ADD CONSTRAINT `ProductListingIndex_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the existing price index. Products without a document fall back to their base
-- price in the listing until the next reindex writes their row.
INSERT INTO `ProductListingIndex` (`id`, `productId`, `minPricePaise`, `maxPricePaise`, `computedAt`, `updatedAt`)
SELECT REPLACE(UUID(), '-', ''), d.`entityId`, d.`minPricePaise`, d.`maxPricePaise`, d.`indexedAt`, CURRENT_TIMESTAMP(3)
FROM `SearchDocument` d
JOIN `Product` p ON p.`id` = d.`entityId` AND p.`deletedAt` IS NULL
WHERE d.`entityType` = 'PRODUCT' AND d.`locale` = 'en';
