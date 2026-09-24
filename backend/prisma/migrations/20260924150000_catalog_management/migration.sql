-- Catalog management phase (docs/DB_MIGRATION_PLAN.md section 4d).
--
-- Additive only: five nullable columns, one index and one new table. No existing row changes and
-- no backfill is needed - every new column means "not configured" when NULL.
--
--   Category.leadFormKey     the enquiry form a category offers (contract work, interiors)
--   AttributeValue.description   customer-facing option text shown in the option matrix
--   Product.featuredUntil    time-boxed featuring; the listing reconciler handles the boundary
--   Product.badgeText/badgeColor  an admin-written merchandising badge
--   Collection.imageMediaId  the collection's tile image (the banner stays its page header)
--   Enquiry                  project / quote requests - never an order, never priced

-- AlterTable
ALTER TABLE `Category` ADD COLUMN `leadFormKey` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `AttributeValue` ADD COLUMN `description` VARCHAR(1000) NULL;

-- AlterTable
ALTER TABLE `Product` ADD COLUMN `badgeColor` VARCHAR(16) NULL,
    ADD COLUMN `badgeText` VARCHAR(64) NULL,
    ADD COLUMN `featuredUntil` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `Collection` ADD COLUMN `imageMediaId` VARCHAR(64) NULL;

-- CreateTable
CREATE TABLE `Enquiry` (
    `id` VARCHAR(64) NOT NULL,
    `formKey` VARCHAR(64) NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'NEW',
    `name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(32) NULL,
    `pincode` VARCHAR(16) NULL,
    `city` VARCHAR(120) NULL,
    `companyName` VARCHAR(255) NULL,
    `message` TEXT NULL,
    `quantity` INTEGER NULL,
    `budgetPaise` INTEGER NULL,
    `categoryId` VARCHAR(64) NULL,
    `productId` VARCHAR(64) NULL,
    `customerId` VARCHAR(64) NULL,
    `assignedToId` VARCHAR(64) NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT 'WEB',
    `detailsJson` LONGTEXT NULL,
    `adminNote` TEXT NULL,
    `ip` VARCHAR(45) NULL,
    `userAgent` VARCHAR(512) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Enquiry_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `Enquiry_formKey_createdAt_idx`(`formKey`, `createdAt`),
    INDEX `Enquiry_categoryId_idx`(`categoryId`),
    INDEX `Enquiry_assignedToId_status_idx`(`assignedToId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Product_featuredUntil_idx` ON `Product`(`featuredUntil`);
