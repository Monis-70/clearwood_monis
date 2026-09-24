-- Prompt 5: the listing's attribute projection (docs/DB_MIGRATION_PLAN.md section 4c).
--
-- At 50,000 products the storefront's attribute facets spent ~1.5 s de-duplicating spec and
-- active-variant option rows per request, and attribute filters fell back to scanning every
-- variant. This table holds that de-duplicated set once per product; listingIndex.service
-- rewrites a product's rows together with its ProductListingIndex row, under the same lock.

-- CreateTable
CREATE TABLE `ProductListingAttribute` (
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `attributeId` VARCHAR(64) NOT NULL,
    `attributeValueId` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProductListingAttribute_value_product_idx`(`attributeValueId`, `productId`),
    INDEX `ProductListingAttribute_attributeId_idx`(`attributeId`),
    UNIQUE INDEX `ProductListingAttribute_product_value_key`(`productId`, `attributeId`, `attributeValueId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProductListingAttribute` ADD CONSTRAINT `ProductListingAttribute_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductListingAttribute` ADD CONSTRAINT `ProductListingAttribute_attributeId_fkey` FOREIGN KEY (`attributeId`) REFERENCES `Attribute`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductListingAttribute` ADD CONSTRAINT `ProductListingAttribute_attributeValueId_fkey` FOREIGN KEY (`attributeValueId`) REFERENCES `AttributeValue`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill every product that has a listing index row, from the same rows the listing read until
-- now: spec values plus the option values of active, non-deleted variants, each pair once.
INSERT INTO `ProductListingAttribute` (`id`, `productId`, `attributeId`, `attributeValueId`, `updatedAt`)
SELECT REPLACE(UUID(), '-', ''), t.`productId`, t.`attributeId`, t.`attributeValueId`, CURRENT_TIMESTAMP(3)
FROM (
    SELECT pav.`productId`, pav.`attributeId`, pav.`attributeValueId`
    FROM `ProductAttributeValue` pav
    JOIN `ProductListingIndex` li ON li.`productId` = pav.`productId`
    WHERE pav.`attributeValueId` IS NOT NULL
    UNION
    SELECT v.`productId`, vav.`attributeId`, vav.`attributeValueId`
    FROM `VariantAttributeValue` vav
    JOIN `ProductVariant` v ON v.`id` = vav.`variantId` AND v.`deletedAt` IS NULL AND v.`isActive` = TRUE
    JOIN `ProductListingIndex` li ON li.`productId` = v.`productId`
) t;
