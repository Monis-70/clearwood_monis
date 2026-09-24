-- Catalog integrity: at most one default variant, one primary category and one primary image per
-- product; one variant per option combination; a soft-deleted product releases its slug.
--
-- Each singleton is a nullable "mark" column (TRUE or NULL, never FALSE) under a unique index on
-- (productId, mark): MySQL allows any number of NULLs in a unique index but only one TRUE per
-- product. A CHECK ties every mark to the flag it mirrors. `<=>` is used because a CHECK that
-- evaluates to NULL counts as satisfied.
--
-- Existing rows are remediated BEFORE the constraints are created, so this runs on any data.

SET SESSION group_concat_max_len = 1048576;

-- AlterTable
ALTER TABLE `Product` ADD COLUMN `deletedSlug` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `ProductCategory` ADD COLUMN `primaryMark` BOOLEAN NULL;

-- AlterTable
ALTER TABLE `ProductMedia` ADD COLUMN `primaryMark` BOOLEAN NULL;

-- AlterTable
ALTER TABLE `ProductVariant` ADD COLUMN `combinationKey` CHAR(64) NULL,
    ADD COLUMN `defaultMark` BOOLEAN NULL;

-- Remediate: a deleted variant is never the default (the delete path already clears it).
UPDATE `ProductVariant` SET `isDefault` = false WHERE `deletedAt` IS NOT NULL AND `isDefault` = true;

-- Remediate: one default per product - the first by position, then id; the rest are demoted.
UPDATE `ProductVariant` v
JOIN (
    SELECT `id` FROM (
        SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `productId` ORDER BY `position`, `id`) AS `rn`
        FROM `ProductVariant` WHERE `isDefault` = true
    ) ranked WHERE ranked.`rn` > 1
) extra ON extra.`id` = v.`id`
SET v.`isDefault` = false;

UPDATE `ProductVariant` SET `defaultMark` = true WHERE `isDefault` = true;

-- Remediate: one primary category per product, chosen the same way.
UPDATE `ProductCategory` pc
JOIN (
    SELECT `id` FROM (
        SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `productId` ORDER BY `position`, `id`) AS `rn`
        FROM `ProductCategory` WHERE `isPrimary` = true
    ) ranked WHERE ranked.`rn` > 1
) extra ON extra.`id` = pc.`id`
SET pc.`isPrimary` = false;

UPDATE `ProductCategory` SET `primaryMark` = true WHERE `isPrimary` = true;

-- Remediate: one primary image per product; extra primaries become GALLERY, which is what the
-- admin "set primary" path has always done to the previous one.
UPDATE `ProductMedia` pm
JOIN (
    SELECT `id` FROM (
        SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `productId` ORDER BY `position`, `id`) AS `rn`
        FROM `ProductMedia` WHERE `role` = 'PRIMARY'
    ) ranked WHERE ranked.`rn` > 1
) extra ON extra.`id` = pm.`id`
SET pm.`role` = 'GALLERY';

UPDATE `ProductMedia` SET `primaryMark` = true WHERE `role` = 'PRIMARY';

-- Backfill: the combination key of every live variant with options. MUST match
-- combinationKeyOf() in src/modules/catalog-admin/variantOptions.ts byte for byte: pairs
-- `attributeId=attributeValueId`, ordered by attributeId in binary order, joined with `&`.
UPDATE `ProductVariant` v
JOIN (
    SELECT vav.`variantId`,
        SHA2(GROUP_CONCAT(CONCAT(vav.`attributeId`, '=', vav.`attributeValueId`)
            ORDER BY vav.`attributeId` COLLATE utf8mb4_bin SEPARATOR '&'), 256) AS `combo`
    FROM `VariantAttributeValue` vav
    GROUP BY vav.`variantId`
) c ON c.`variantId` = v.`id`
SET v.`combinationKey` = c.`combo`
WHERE v.`deletedAt` IS NULL;

-- Remediate: an existing duplicate combination keeps its rows (orders may reference them), but
-- only the first variant holds the key. Find the others with:
--   SELECT id, sku FROM ProductVariant v WHERE deletedAt IS NULL AND combinationKey IS NULL
--     AND EXISTS (SELECT 1 FROM VariantAttributeValue a WHERE a.variantId = v.id);
UPDATE `ProductVariant` v
JOIN (
    SELECT `id` FROM (
        SELECT `id`,
            ROW_NUMBER() OVER (PARTITION BY `productId`, `combinationKey` ORDER BY `position`, `id`) AS `rn`
        FROM `ProductVariant` WHERE `combinationKey` IS NOT NULL
    ) ranked WHERE ranked.`rn` > 1
) extra ON extra.`id` = v.`id`
SET v.`combinationKey` = NULL;

-- Backfill: soft-deleted products give their slug up, so a new product can take it.
UPDATE `Product` SET `deletedSlug` = `slug`, `slug` = CONCAT('deleted-', `id`)
WHERE `deletedAt` IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `ProductCategory_productId_primaryMark_key` ON `ProductCategory`(`productId`, `primaryMark`);

-- CreateIndex
CREATE UNIQUE INDEX `ProductVariant_productId_defaultMark_key` ON `ProductVariant`(`productId`, `defaultMark`);

-- CreateIndex
CREATE UNIQUE INDEX `ProductVariant_productId_combinationKey_key` ON `ProductVariant`(`productId`, `combinationKey`);

-- CreateIndex
CREATE UNIQUE INDEX `ProductMedia_productId_primaryMark_key` ON `ProductMedia`(`productId`, `primaryMark`);

-- AddCheckConstraint (Prisma cannot model CHECK; tests/catalog-integrity.test.ts asserts they exist)
ALTER TABLE `ProductVariant` ADD CONSTRAINT `ProductVariant_defaultMark_check`
    CHECK ((`isDefault` = true AND `defaultMark` <=> true) OR (`isDefault` = false AND `defaultMark` IS NULL));

-- AddCheckConstraint
ALTER TABLE `ProductCategory` ADD CONSTRAINT `ProductCategory_primaryMark_check`
    CHECK ((`isPrimary` = true AND `primaryMark` <=> true) OR (`isPrimary` = false AND `primaryMark` IS NULL));

-- AddCheckConstraint
ALTER TABLE `ProductMedia` ADD CONSTRAINT `ProductMedia_primaryMark_check`
    CHECK ((`role` = 'PRIMARY' AND `primaryMark` <=> true) OR (`role` <> 'PRIMARY' AND `primaryMark` IS NULL));
