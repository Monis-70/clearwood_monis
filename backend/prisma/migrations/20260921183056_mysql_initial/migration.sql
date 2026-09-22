-- CreateTable
CREATE TABLE `AppSetting` (
    `id` VARCHAR(64) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `value` TEXT NOT NULL,
    `group` VARCHAR(64) NOT NULL,
    `valueType` VARCHAR(64) NOT NULL,
    `isPublic` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AppSetting_key_key`(`key`),
    INDEX `AppSetting_group_idx`(`group`),
    INDEX `AppSetting_isPublic_idx`(`isPublic`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(64) NOT NULL,
    `actorType` VARCHAR(64) NOT NULL,
    `actorId` VARCHAR(64) NULL,
    `actorName` VARCHAR(255) NULL,
    `actorEmail` VARCHAR(191) NULL,
    `realm` VARCHAR(64) NULL,
    `action` VARCHAR(64) NOT NULL,
    `entity` VARCHAR(64) NOT NULL,
    `entityId` VARCHAR(64) NULL,
    `severity` VARCHAR(64) NOT NULL DEFAULT 'INFO',
    `requestId` VARCHAR(64) NULL,
    `meta` TEXT NULL,
    `changesJson` LONGTEXT NULL,
    `ip` VARCHAR(45) NULL,
    `userAgent` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_entity_entityId_idx`(`entity`, `entityId`),
    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    INDEX `AuditLog_actorId_createdAt_idx`(`actorId`, `createdAt`),
    INDEX `AuditLog_action_createdAt_idx`(`action`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaxClass` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `rateBp` INTEGER NOT NULL,
    `hsnCode` VARCHAR(64) NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `TaxClass_code_key`(`code`),
    INDEX `TaxClass_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Brand` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `logoMediaId` VARCHAR(64) NULL,
    `description` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `position` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Brand_slug_key`(`slug`),
    INDEX `Brand_isActive_position_idx`(`isActive`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Media` (
    `id` VARCHAR(64) NOT NULL,
    `disk` VARCHAR(64) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `url` VARCHAR(255) NULL,
    `kind` VARCHAR(64) NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'READY',
    `source` VARCHAR(64) NOT NULL DEFAULT 'ADMIN_UPLOAD',
    `mimeType` VARCHAR(64) NOT NULL,
    `originalName` VARCHAR(255) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `checksum` CHAR(64) COLLATE utf8mb4_bin NULL,
    `checksumSha256` VARCHAR(191) NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `durationSec` INTEGER NULL,
    `altText` VARCHAR(1000) NULL,
    `title` VARCHAR(255) NULL,
    `blurhash` VARCHAR(255) NULL,
    `dominantColorHex` VARCHAR(16) NULL,
    `lqipDataUri` TEXT NULL,
    `focalPointX` INTEGER NULL,
    `focalPointY` INTEGER NULL,
    `isOptimized` BOOLEAN NOT NULL DEFAULT false,
    `processingError` TEXT NULL,
    `tagsJson` LONGTEXT NULL,
    `usageCount` INTEGER NOT NULL DEFAULT 0,
    `folder` VARCHAR(191) NOT NULL DEFAULT 'uploads',
    `folderId` VARCHAR(64) NULL,
    `uploadedByType` VARCHAR(64) NULL,
    `uploadedById` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Media_kind_idx`(`kind`),
    INDEX `Media_folder_idx`(`folder`),
    INDEX `Media_folderId_idx`(`folderId`),
    INDEX `Media_status_idx`(`status`),
    INDEX `Media_checksumSha256_idx`(`checksumSha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MediaFolder` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `parentId` VARCHAR(64) NULL,
    `path` VARCHAR(255) NOT NULL,
    `depth` INTEGER NOT NULL DEFAULT 0,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `MediaFolder_slug_key`(`slug`),
    INDEX `MediaFolder_parentId_position_idx`(`parentId`, `position`),
    INDEX `MediaFolder_path_idx`(`path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MediaUsage` (
    `id` VARCHAR(64) NOT NULL,
    `mediaId` VARCHAR(64) NOT NULL,
    `usageType` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `field` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MediaUsage_usageType_entityId_idx`(`usageType`, `entityId`),
    UNIQUE INDEX `MediaUsage_mediaId_usageType_entityId_field_key`(`mediaId`, `usageType`, `entityId`, `field`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MediaVariant` (
    `id` VARCHAR(64) NOT NULL,
    `mediaId` VARCHAR(64) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `width` INTEGER NOT NULL,
    `height` INTEGER NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `format` VARCHAR(191) NOT NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `deviceTarget` VARCHAR(64) NOT NULL DEFAULT 'ALL',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MediaVariant_mediaId_deviceTarget_idx`(`mediaId`, `deviceTarget`),
    UNIQUE INDEX `MediaVariant_mediaId_label_format_key`(`mediaId`, `label`, `format`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Category` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `parentId` VARCHAR(64) NULL,
    `path` VARCHAR(255) NOT NULL,
    `depth` INTEGER NOT NULL DEFAULT 0,
    `position` INTEGER NOT NULL DEFAULT 0,
    `kind` VARCHAR(64) NOT NULL DEFAULT 'STANDARD',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `showInMenu` BOOLEAN NOT NULL DEFAULT true,
    `menuColumn` INTEGER NULL,
    `isFeatured` BOOLEAN NOT NULL DEFAULT false,
    `shortDescription` TEXT NULL,
    `description` TEXT NULL,
    `iconMediaId` VARCHAR(64) NULL,
    `bannerMediaId` VARCHAR(64) NULL,
    `mobileBannerMediaId` VARCHAR(64) NULL,
    `seoTitle` VARCHAR(255) NULL,
    `seoDescription` TEXT NULL,
    `seoKeywords` TEXT NULL,
    `productCountCache` INTEGER NOT NULL DEFAULT 0,
    `deleteStrategyNote` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Category_slug_key`(`slug`),
    INDEX `Category_parentId_position_idx`(`parentId`, `position`),
    INDEX `Category_path_idx`(`path`),
    INDEX `Category_isActive_showInMenu_idx`(`isActive`, `showInMenu`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttributeGroup` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AttributeGroup_code_key`(`code`),
    INDEX `AttributeGroup_position_idx`(`position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Attribute` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `groupId` VARCHAR(64) NULL,
    `inputType` VARCHAR(64) NOT NULL,
    `dataType` VARCHAR(64) NOT NULL DEFAULT 'STRING',
    `unit` VARCHAR(64) NULL,
    `isVariantDefining` BOOLEAN NOT NULL DEFAULT false,
    `isFilterable` BOOLEAN NOT NULL DEFAULT true,
    `isSearchable` BOOLEAN NOT NULL DEFAULT false,
    `isRequired` BOOLEAN NOT NULL DEFAULT false,
    `isComparable` BOOLEAN NOT NULL DEFAULT false,
    `showInSwatch` BOOLEAN NOT NULL DEFAULT false,
    `position` INTEGER NOT NULL DEFAULT 0,
    `helpText` VARCHAR(1000) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Attribute_code_key`(`code`),
    INDEX `Attribute_groupId_position_idx`(`groupId`, `position`),
    INDEX `Attribute_isFilterable_idx`(`isFilterable`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttributeValue` (
    `id` VARCHAR(64) NOT NULL,
    `attributeId` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `colorHex` VARCHAR(16) NULL,
    `swatchMediaId` VARCHAR(64) NULL,
    `numericValue` INTEGER NULL,
    `metaJson` LONGTEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `AttributeValue_attributeId_position_idx`(`attributeId`, `position`),
    UNIQUE INDEX `AttributeValue_attributeId_code_key`(`attributeId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CategoryAttribute` (
    `id` VARCHAR(64) NOT NULL,
    `categoryId` VARCHAR(64) NOT NULL,
    `attributeId` VARCHAR(64) NOT NULL,
    `isRequired` BOOLEAN NOT NULL DEFAULT false,
    `isVariantDefining` BOOLEAN NOT NULL DEFAULT false,
    `isFilterable` BOOLEAN NOT NULL DEFAULT true,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CategoryAttribute_categoryId_position_idx`(`categoryId`, `position`),
    UNIQUE INDEX `CategoryAttribute_categoryId_attributeId_key`(`categoryId`, `attributeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Product` (
    `id` VARCHAR(64) NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `subtitle` VARCHAR(255) NULL,
    `shortDescription` TEXT NULL,
    `description` TEXT NULL,
    `productType` VARCHAR(64) NOT NULL DEFAULT 'SIMPLE',
    `status` VARCHAR(64) NOT NULL DEFAULT 'DRAFT',
    `visibility` VARCHAR(64) NOT NULL DEFAULT 'PUBLIC',
    `brandId` VARCHAR(64) NULL,
    `taxClassId` VARCHAR(64) NULL,
    `basePricePaise` INTEGER NOT NULL DEFAULT 0,
    `compareAtPricePaise` INTEGER NULL,
    `costPricePaise` INTEGER NULL,
    `priceNote` VARCHAR(1000) NULL,
    `isMadeToOrder` BOOLEAN NOT NULL DEFAULT false,
    `leadTimeDays` INTEGER NULL,
    `allowCustomization` BOOLEAN NOT NULL DEFAULT false,
    `manufacturedInHouse` BOOLEAN NOT NULL DEFAULT true,
    `manufacturingNote` VARCHAR(255) NULL,
    `warrantyMonths` INTEGER NULL,
    `careInstructions` TEXT NULL,
    `assemblyRequired` BOOLEAN NOT NULL DEFAULT false,
    `weightGrams` INTEGER NULL,
    `lengthMm` INTEGER NULL,
    `widthMm` INTEGER NULL,
    `heightMm` INTEGER NULL,
    `seatHeightMm` INTEGER NULL,
    `isFeatured` BOOLEAN NOT NULL DEFAULT false,
    `isNewArrival` BOOLEAN NOT NULL DEFAULT false,
    `isSpecialCollection` BOOLEAN NOT NULL DEFAULT false,
    `isBestSeller` BOOLEAN NOT NULL DEFAULT false,
    `minOrderQty` INTEGER NOT NULL DEFAULT 1,
    `maxOrderQty` INTEGER NULL,
    `ratingAvgBp` INTEGER NOT NULL DEFAULT 0,
    `ratingCount` INTEGER NOT NULL DEFAULT 0,
    `soldCount` INTEGER NOT NULL DEFAULT 0,
    `position` INTEGER NOT NULL DEFAULT 0,
    `publishedAt` DATETIME(3) NULL,
    `lastPublishedAt` DATETIME(3) NULL,
    `completenessScore` INTEGER NOT NULL DEFAULT 0,
    `publishBlockersJson` LONGTEXT NULL,
    `seoTitle` VARCHAR(255) NULL,
    `seoDescription` TEXT NULL,
    `seoKeywords` TEXT NULL,
    `searchKeywords` TEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Product_sku_key`(`sku`),
    UNIQUE INDEX `Product_slug_key`(`slug`),
    INDEX `Product_status_publishedAt_idx`(`status`, `publishedAt`),
    INDEX `Product_isNewArrival_idx`(`isNewArrival`),
    INDEX `Product_isFeatured_idx`(`isFeatured`),
    INDEX `Product_basePricePaise_idx`(`basePricePaise`),
    INDEX `Product_completenessScore_idx`(`completenessScore`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductCategory` (
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `categoryId` VARCHAR(64) NOT NULL,
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProductCategory_categoryId_position_idx`(`categoryId`, `position`),
    UNIQUE INDEX `ProductCategory_productId_categoryId_key`(`productId`, `categoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductAttributeValue` (
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `attributeId` VARCHAR(64) NOT NULL,
    `attributeValueId` VARCHAR(64) NULL,
    `valueText` VARCHAR(1000) NULL,
    `valueNumber` INTEGER NULL,
    `valueBoolean` BOOLEAN NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProductAttributeValue_productId_position_idx`(`productId`, `position`),
    UNIQUE INDEX `ProductAttributeValue_productId_attributeId_attributeValueId_key`(`productId`, `attributeId`, `attributeValueId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductVariant` (
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NULL,
    `pricePaise` INTEGER NULL,
    `compareAtPricePaise` INTEGER NULL,
    `costPricePaise` INTEGER NULL,
    `weightGrams` INTEGER NULL,
    `barcode` VARCHAR(64) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `stockQty` INTEGER NOT NULL DEFAULT 0,
    `reservedQty` INTEGER NOT NULL DEFAULT 0,
    `stockStatus` VARCHAR(64) NOT NULL DEFAULT 'IN_STOCK',
    `lowStockThreshold` INTEGER NOT NULL DEFAULT 0,
    `allowBackorder` BOOLEAN NOT NULL DEFAULT false,
    `leadTimeDays` INTEGER NULL,
    `lengthMm` INTEGER NULL,
    `widthMm` INTEGER NULL,
    `heightMm` INTEGER NULL,
    `packageCount` INTEGER NOT NULL DEFAULT 1,
    `packagingType` VARCHAR(64) NOT NULL DEFAULT 'BOX',
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `ProductVariant_sku_key`(`sku`),
    INDEX `ProductVariant_productId_position_idx`(`productId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VariantAttributeValue` (
    `id` VARCHAR(64) NOT NULL,
    `variantId` VARCHAR(64) NOT NULL,
    `attributeId` VARCHAR(64) NOT NULL,
    `attributeValueId` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `VariantAttributeValue_attributeValueId_idx`(`attributeValueId`),
    UNIQUE INDEX `VariantAttributeValue_variantId_attributeId_key`(`variantId`, `attributeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductMedia` (
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `mediaId` VARCHAR(64) NOT NULL,
    `role` VARCHAR(64) NOT NULL DEFAULT 'GALLERY',
    `position` INTEGER NOT NULL DEFAULT 0,
    `altText` VARCHAR(1000) NULL,
    `deviceTarget` VARCHAR(64) NOT NULL DEFAULT 'ALL',
    `attributeValueId` VARCHAR(64) NULL,
    `variantId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProductMedia_productId_position_idx`(`productId`, `position`),
    INDEX `ProductMedia_productId_attributeValueId_idx`(`productId`, `attributeValueId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PriceAdjustment` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `scope` VARCHAR(64) NOT NULL,
    `adjustmentType` VARCHAR(64) NOT NULL,
    `basis` VARCHAR(64) NOT NULL DEFAULT 'BASE',
    `priority` INTEGER NOT NULL DEFAULT 100,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `valuePaise` INTEGER NULL,
    `valueBp` INTEGER NULL,
    `categoryId` VARCHAR(64) NULL,
    `productId` VARCHAR(64) NULL,
    `variantId` VARCHAR(64) NULL,
    `attributeId` VARCHAR(64) NULL,
    `attributeValueId` VARCHAR(64) NULL,
    `customerGroupId` VARCHAR(64) NULL,
    `channel` VARCHAR(64) NOT NULL DEFAULT 'ALL',
    `minQty` INTEGER NULL,
    `maxQty` INTEGER NULL,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `conditionsJson` LONGTEXT NULL,
    `note` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `PriceAdjustment_scope_isActive_priority_idx`(`scope`, `isActive`, `priority`),
    INDEX `PriceAdjustment_productId_idx`(`productId`),
    INDEX `PriceAdjustment_attributeValueId_idx`(`attributeValueId`),
    INDEX `PriceAdjustment_customerGroupId_idx`(`customerGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Collection` (
    `id` VARCHAR(64) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `type` VARCHAR(64) NOT NULL DEFAULT 'MANUAL',
    `description` TEXT NULL,
    `rulesJson` LONGTEXT NULL,
    `bannerMediaId` VARCHAR(64) NULL,
    `mobileBannerMediaId` VARCHAR(64) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `position` INTEGER NOT NULL DEFAULT 0,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `seoTitle` VARCHAR(255) NULL,
    `seoDescription` TEXT NULL,
    `lastEvaluatedAt` DATETIME(3) NULL,
    `evaluatedCount` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Collection_slug_key`(`slug`),
    INDEX `Collection_isActive_position_idx`(`isActive`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CollectionProduct` (
    `id` VARCHAR(64) NOT NULL,
    `collectionId` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CollectionProduct_collectionId_position_idx`(`collectionId`, `position`),
    UNIQUE INDEX `CollectionProduct_collectionId_productId_key`(`collectionId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SlugRedirect` (
    `id` VARCHAR(64) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `fromSlug` VARCHAR(191) NOT NULL,
    `toSlug` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(64) NOT NULL,
    `statusCode` INTEGER NOT NULL DEFAULT 301,
    `hitCount` INTEGER NOT NULL DEFAULT 0,
    `lastHitAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SlugRedirect_entityId_idx`(`entityId`),
    INDEX `SlugRedirect_entityType_toSlug_idx`(`entityType`, `toSlug`),
    UNIQUE INDEX `SlugRedirect_entityType_fromSlug_key`(`entityType`, `fromSlug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InventoryLedger` (
    `id` VARCHAR(64) NOT NULL,
    `variantId` VARCHAR(64) NOT NULL,
    `delta` INTEGER NOT NULL,
    `balanceAfter` INTEGER NOT NULL,
    `reason` VARCHAR(64) NOT NULL,
    `refType` VARCHAR(64) NULL,
    `refId` VARCHAR(64) NULL,
    `note` VARCHAR(1000) NULL,
    `actorType` VARCHAR(64) NOT NULL DEFAULT 'SYSTEM',
    `actorId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `InventoryLedger_variantId_createdAt_idx`(`variantId`, `createdAt`),
    INDEX `InventoryLedger_reason_createdAt_idx`(`reason`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductRelation` (
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `relatedProductId` VARCHAR(64) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProductRelation_relatedProductId_idx`(`relatedProductId`),
    UNIQUE INDEX `ProductRelation_productId_relatedProductId_type_key`(`productId`, `relatedProductId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ImportJob` (
    `id` VARCHAR(64) NOT NULL,
    `entity` VARCHAR(64) NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `fileName` VARCHAR(255) NOT NULL,
    `mediaId` VARCHAR(64) NULL,
    `dryRun` BOOLEAN NOT NULL DEFAULT true,
    `totalRows` INTEGER NOT NULL DEFAULT 0,
    `processedRows` INTEGER NOT NULL DEFAULT 0,
    `successRows` INTEGER NOT NULL DEFAULT 0,
    `errorRows` INTEGER NOT NULL DEFAULT 0,
    `errorsJson` LONGTEXT NULL,
    `summaryJson` LONGTEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ImportJob_entity_status_idx`(`entity`, `status`),
    INDEX `ImportJob_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IdempotencyKey` (
    `id` VARCHAR(64) NOT NULL,
    `key` VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `principalType` VARCHAR(64) NOT NULL,
    `principalId` VARCHAR(64) NULL,
    `method` VARCHAR(64) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `requestHash` CHAR(64) COLLATE utf8mb4_bin NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'IN_PROGRESS',
    `responseStatus` INTEGER NULL,
    `responseJson` LONGTEXT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `IdempotencyKey_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `IdempotencyKey_scope_key_key`(`scope`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerGroup` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `discountBp` INTEGER NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `CustomerGroup_code_key`(`code`),
    INDEX `CustomerGroup_isActive_priority_idx`(`isActive`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerGroupMember` (
    `id` VARCHAR(64) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(64) NOT NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CustomerGroupMember_groupId_idx`(`groupId`),
    UNIQUE INDEX `CustomerGroupMember_customerId_groupId_key`(`customerId`, `groupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PriceList` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `customerGroupId` VARCHAR(64) NULL,
    `channel` VARCHAR(64) NOT NULL DEFAULT 'WEB',
    `priority` INTEGER NOT NULL DEFAULT 100,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `PriceList_code_key`(`code`),
    INDEX `PriceList_isActive_priority_idx`(`isActive`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PriceListItem` (
    `id` VARCHAR(64) NOT NULL,
    `priceListId` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(191) NULL,
    `variantId` VARCHAR(191) NULL,
    `minQty` INTEGER NOT NULL DEFAULT 1,
    `pricePaise` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PriceListItem_productId_idx`(`productId`),
    INDEX `PriceListItem_variantId_idx`(`variantId`),
    UNIQUE INDEX `PriceListItem_priceListId_productId_variantId_minQty_key`(`priceListId`, `productId`, `variantId`, `minQty`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TierPrice` (
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NULL,
    `variantId` VARCHAR(64) NULL,
    `customerGroupId` VARCHAR(64) NULL,
    `minQty` INTEGER NOT NULL,
    `pricePaise` INTEGER NULL,
    `discountBp` INTEGER NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `TierPrice_productId_minQty_idx`(`productId`, `minQty`),
    INDEX `TierPrice_variantId_minQty_idx`(`variantId`, `minQty`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Coupon` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `valueBp` INTEGER NULL,
    `valuePaise` INTEGER NULL,
    `minSubtotalPaise` INTEGER NULL,
    `maxDiscountPaise` INTEGER NULL,
    `usageLimit` INTEGER NULL,
    `perCustomerLimit` INTEGER NULL,
    `usedCount` INTEGER NOT NULL DEFAULT 0,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isStackable` BOOLEAN NOT NULL DEFAULT false,
    `isAutoApply` BOOLEAN NOT NULL DEFAULT false,
    `firstOrderOnly` BOOLEAN NOT NULL DEFAULT false,
    `appliesToJson` LONGTEXT NULL,
    `description` TEXT NULL,
    `termsText` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Coupon_code_key`(`code`),
    INDEX `Coupon_isActive_startsAt_endsAt_idx`(`isActive`, `startsAt`, `endsAt`),
    INDEX `Coupon_isAutoApply_isActive_idx`(`isAutoApply`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CouponRedemption` (
    `id` VARCHAR(64) NOT NULL,
    `couponId` VARCHAR(64) NOT NULL,
    `customerId` VARCHAR(64) NULL,
    `orderId` VARCHAR(191) NULL,
    `amountPaise` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(64) NOT NULL DEFAULT 'RESERVED',
    `reservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `confirmedAt` DATETIME(3) NULL,
    `releasedAt` DATETIME(3) NULL,

    INDEX `CouponRedemption_couponId_customerId_idx`(`couponId`, `customerId`),
    INDEX `CouponRedemption_status_idx`(`status`),
    UNIQUE INDEX `CouponRedemption_couponId_orderId_key`(`couponId`, `orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DiscountRule` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `scope` VARCHAR(64) NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `stopFurtherRules` BOOLEAN NOT NULL DEFAULT false,
    `conditionsJson` LONGTEXT NOT NULL,
    `actionsJson` LONGTEXT NOT NULL,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `usageLimit` INTEGER NULL,
    `usedCount` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `DiscountRule_code_key`(`code`),
    INDEX `DiscountRule_isActive_scope_priority_idx`(`isActive`, `scope`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShippingZone` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `ShippingZone_code_key`(`code`),
    INDEX `ShippingZone_isActive_priority_idx`(`isActive`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShippingPincode` (
    `id` VARCHAR(64) NOT NULL,
    `zoneId` VARCHAR(64) NOT NULL,
    `pincode` VARCHAR(191) NOT NULL,
    `city` VARCHAR(120) NULL,
    `state` VARCHAR(64) NULL,
    `stateCode` VARCHAR(64) NULL,
    `isServiceable` BOOLEAN NOT NULL DEFAULT true,
    `codAvailable` BOOLEAN NOT NULL DEFAULT false,
    `etaMinDays` INTEGER NULL,
    `etaMaxDays` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ShippingPincode_pincode_key`(`pincode`),
    INDEX `ShippingPincode_zoneId_idx`(`zoneId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShippingPincodeRange` (
    `id` VARCHAR(64) NOT NULL,
    `zoneId` VARCHAR(64) NOT NULL,
    `fromPincode` VARCHAR(191) NOT NULL,
    `toPincode` VARCHAR(191) NOT NULL,
    `stateCode` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ShippingPincodeRange_zoneId_idx`(`zoneId`),
    INDEX `ShippingPincodeRange_fromPincode_toPincode_idx`(`fromPincode`, `toPincode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShippingRate` (
    `id` VARCHAR(64) NOT NULL,
    `zoneId` VARCHAR(64) NOT NULL,
    `method` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `conditionType` VARCHAR(64) NOT NULL,
    `minValue` INTEGER NULL,
    `maxValue` INTEGER NULL,
    `basePaise` INTEGER NOT NULL,
    `perUnitPaise` INTEGER NULL,
    `freeAbovePaise` INTEGER NULL,
    `etaMinDays` INTEGER NULL,
    `etaMaxDays` INTEGER NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `ShippingRate_zoneId_method_priority_idx`(`zoneId`, `method`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NavigationMenu` (
    `id` VARCHAR(64) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NavigationMenu_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NavigationItem` (
    `id` VARCHAR(64) NOT NULL,
    `menuId` VARCHAR(64) NOT NULL,
    `parentId` VARCHAR(64) NULL,
    `label` VARCHAR(255) NOT NULL,
    `type` VARCHAR(64) NOT NULL DEFAULT 'CATEGORY',
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isHighlighted` BOOLEAN NOT NULL DEFAULT false,
    `badgeText` VARCHAR(64) NULL,
    `badgeColor` VARCHAR(16) NULL,
    `url` VARCHAR(255) NULL,
    `categoryId` VARCHAR(64) NULL,
    `collectionId` VARCHAR(64) NULL,
    `leadFormKey` VARCHAR(64) NULL,
    `iconMediaId` VARCHAR(64) NULL,
    `menuColumn` INTEGER NULL,
    `openInNewTab` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NavigationItem_menuId_parentId_position_idx`(`menuId`, `parentId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminUser` (
    `id` VARCHAR(64) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `name` VARCHAR(255) NOT NULL,
    `passwordHash` VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'INVITED',
    `avatarMediaId` VARCHAR(64) NULL,
    `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    `lastLoginAt` DATETIME(3) NULL,
    `lastLoginIp` VARCHAR(45) NULL,
    `failedLoginCount` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `passwordChangedAt` DATETIME(3) NULL,
    `invitedById` VARCHAR(64) NULL,
    `invitedAt` DATETIME(3) NULL,
    `permissionVersion` INTEGER NOT NULL DEFAULT 1,
    `twoFactorSecret` VARCHAR(255) COLLATE utf8mb4_bin NULL,
    `twoFactorEnabledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `AdminUser_email_key`(`email`),
    INDEX `AdminUser_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Role` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Role_code_key`(`code`),
    INDEX `Role_position_idx`(`position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Permission` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `group` VARCHAR(64) NOT NULL,
    `description` TEXT NULL,
    `isDangerous` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Permission_code_key`(`code`),
    INDEX `Permission_group_idx`(`group`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RolePermission` (
    `id` VARCHAR(64) NOT NULL,
    `roleId` VARCHAR(64) NOT NULL,
    `permissionId` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RolePermission_permissionId_idx`(`permissionId`),
    UNIQUE INDEX `RolePermission_roleId_permissionId_key`(`roleId`, `permissionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminUserRole` (
    `id` VARCHAR(64) NOT NULL,
    `adminUserId` VARCHAR(64) NOT NULL,
    `roleId` VARCHAR(64) NOT NULL,
    `assignedById` VARCHAR(64) NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AdminUserRole_roleId_idx`(`roleId`),
    UNIQUE INDEX `AdminUserRole_adminUserId_roleId_key`(`adminUserId`, `roleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Customer` (
    `id` VARCHAR(64) NOT NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `name` VARCHAR(255) NULL,
    `passwordHash` VARCHAR(255) COLLATE utf8mb4_bin NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'ACTIVE',
    `emailVerifiedAt` DATETIME(3) NULL,
    `phoneVerifiedAt` DATETIME(3) NULL,
    `defaultAddressId` VARCHAR(64) NULL,
    `marketingOptIn` BOOLEAN NOT NULL DEFAULT false,
    `acceptsWhatsapp` BOOLEAN NOT NULL DEFAULT true,
    `lastLoginAt` DATETIME(3) NULL,
    `failedLoginCount` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `avatarMediaId` VARCHAR(64) NULL,
    `referralCode` VARCHAR(191) NULL,
    `notesJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Customer_email_key`(`email`),
    UNIQUE INDEX `Customer_phone_key`(`phone`),
    UNIQUE INDEX `Customer_referralCode_key`(`referralCode`),
    INDEX `Customer_status_idx`(`status`),
    INDEX `Customer_defaultAddressId_idx`(`defaultAddressId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefreshToken` (
    `id` VARCHAR(64) NOT NULL,
    `principalType` VARCHAR(64) NOT NULL,
    `principalId` VARCHAR(64) NOT NULL,
    `tokenHash` CHAR(64) COLLATE utf8mb4_bin NOT NULL,
    `familyId` VARCHAR(64) NOT NULL,
    `parentId` VARCHAR(64) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(1000) NULL,
    `usedAt` DATETIME(3) NULL,
    `ip` VARCHAR(45) NULL,
    `userAgent` VARCHAR(512) NULL,
    `deviceLabel` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RefreshToken_tokenHash_key`(`tokenHash`),
    INDEX `RefreshToken_principalType_principalId_idx`(`principalType`, `principalId`),
    INDEX `RefreshToken_familyId_idx`(`familyId`),
    INDEX `RefreshToken_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OtpChallenge` (
    `id` VARCHAR(64) NOT NULL,
    `channel` VARCHAR(64) NOT NULL,
    `purpose` VARCHAR(191) NOT NULL,
    `destination` VARCHAR(191) NOT NULL,
    `codeHash` CHAR(64) COLLATE utf8mb4_bin NOT NULL,
    `principalType` VARCHAR(64) NULL,
    `principalId` VARCHAR(64) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 5,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `lastSentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resendCount` INTEGER NOT NULL DEFAULT 0,
    `ip` VARCHAR(45) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OtpChallenge_destination_purpose_idx`(`destination`, `purpose`),
    INDEX `OtpChallenge_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VerificationToken` (
    `id` VARCHAR(64) NOT NULL,
    `purpose` VARCHAR(191) NOT NULL,
    `principalType` VARCHAR(64) NOT NULL,
    `principalId` VARCHAR(64) NOT NULL,
    `tokenHash` CHAR(64) COLLATE utf8mb4_bin NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `metaJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `VerificationToken_tokenHash_key`(`tokenHash`),
    INDEX `VerificationToken_principalType_principalId_purpose_idx`(`principalType`, `principalId`, `purpose`),
    INDEX `VerificationToken_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LoginAttempt` (
    `id` VARCHAR(64) NOT NULL,
    `realm` VARCHAR(64) NOT NULL,
    `identifier` VARCHAR(191) NOT NULL,
    `success` BOOLEAN NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `ip` VARCHAR(191) NULL,
    `userAgent` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LoginAttempt_identifier_createdAt_idx`(`identifier`, `createdAt`),
    INDEX `LoginAttempt_ip_createdAt_idx`(`ip`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SearchDocument` (
    `id` VARCHAR(64) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `subtitle` VARCHAR(255) NULL,
    `bodyText` TEXT NOT NULL,
    `keywordsText` TEXT NOT NULL,
    `brandText` TEXT NULL,
    `categoryText` TEXT NOT NULL,
    `attributeText` TEXT NOT NULL,
    `sku` VARCHAR(191) NULL,
    `slug` VARCHAR(191) NOT NULL,
    `locale` VARCHAR(191) NOT NULL DEFAULT 'en',
    `minPricePaise` INTEGER NULL,
    `maxPricePaise` INTEGER NULL,
    `inStock` BOOLEAN NOT NULL DEFAULT true,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `popularityScore` INTEGER NOT NULL DEFAULT 0,
    `boostScore` INTEGER NOT NULL DEFAULT 0,
    `indexedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `checksum` CHAR(64) COLLATE utf8mb4_bin NOT NULL,

    INDEX `SearchDocument_entityType_isActive_idx`(`entityType`, `isActive`),
    INDEX `SearchDocument_slug_idx`(`slug`),
    INDEX `SearchDocument_popularityScore_idx`(`popularityScore`),
    INDEX `SearchDocument_minPricePaise_idx`(`minPricePaise`),
    UNIQUE INDEX `SearchDocument_entityType_entityId_locale_key`(`entityType`, `entityId`, `locale`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SearchSynonym` (
    `term` VARCHAR(64) NOT NULL,
    `synonymsJson` LONGTEXT NOT NULL,
    `isTwoWay` BOOLEAN NOT NULL DEFAULT true,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `note` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`term`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SearchQueryLog` (
    `id` VARCHAR(64) NOT NULL,
    `rawQuery` VARCHAR(255) NOT NULL,
    `normalizedQuery` VARCHAR(191) NOT NULL,
    `resultCount` INTEGER NOT NULL DEFAULT 0,
    `hasResults` BOOLEAN NOT NULL DEFAULT false,
    `filtersJson` LONGTEXT NULL,
    `customerId` VARCHAR(64) NULL,
    `sessionId` VARCHAR(64) COLLATE utf8mb4_bin NULL,
    `ip` VARCHAR(45) NULL,
    `clickedEntityType` VARCHAR(64) NULL,
    `clickedEntityId` VARCHAR(64) NULL,
    `clickPosition` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SearchQueryLog_normalizedQuery_createdAt_idx`(`normalizedQuery`, `createdAt`),
    INDEX `SearchQueryLog_hasResults_createdAt_idx`(`hasResults`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductStat` (
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `viewCount` INTEGER NOT NULL DEFAULT 0,
    `viewCount7d` INTEGER NOT NULL DEFAULT 0,
    `wishlistCount` INTEGER NOT NULL DEFAULT 0,
    `cartAddCount` INTEGER NOT NULL DEFAULT 0,
    `purchaseCount` INTEGER NOT NULL DEFAULT 0,
    `popularityScore` INTEGER NOT NULL DEFAULT 0,
    `lastViewedAt` DATETIME(3) NULL,
    `recomputedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProductStat_productId_key`(`productId`),
    INDEX `ProductStat_popularityScore_idx`(`popularityScore`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SearchIndexJob` (
    `id` VARCHAR(64) NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `entityType` VARCHAR(64) NULL,
    `isFull` BOOLEAN NOT NULL DEFAULT false,
    `total` INTEGER NOT NULL DEFAULT 0,
    `processed` INTEGER NOT NULL DEFAULT 0,
    `failed` INTEGER NOT NULL DEFAULT 0,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `errorsJson` LONGTEXT NULL,
    `triggeredById` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SearchIndexJob_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Cart` (
    `id` VARCHAR(64) NOT NULL,
    `customerId` VARCHAR(64) NULL,
    `sessionId` VARCHAR(64) COLLATE utf8mb4_bin NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'ACTIVE',
    `activeOwnerKey` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `channel` VARCHAR(64) NOT NULL DEFAULT 'WEB',
    `currency` VARCHAR(64) NOT NULL DEFAULT 'INR',
    `couponCode` VARCHAR(64) NULL,
    `pincode` VARCHAR(16) NULL,
    `customerGroupIdSnapshot` VARCHAR(64) NULL,
    `itemCount` INTEGER NOT NULL DEFAULT 0,
    `quantityTotal` INTEGER NOT NULL DEFAULT 0,
    `lastQuotedTotalPaise` INTEGER NULL,
    `lastQuoteContextHash` CHAR(64) COLLATE utf8mb4_bin NULL,
    `lastQuotedAt` DATETIME(3) NULL,
    `lastActivityAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NULL,
    `mergedIntoCartId` VARCHAR(64) NULL,
    `convertedOrderId` VARCHAR(64) NULL,
    `notesJson` LONGTEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Cart_activeOwnerKey_key`(`activeOwnerKey`),
    INDEX `Cart_customerId_status_idx`(`customerId`, `status`),
    INDEX `Cart_sessionId_status_idx`(`sessionId`, `status`),
    INDEX `Cart_status_lastActivityAt_idx`(`status`, `lastActivityAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CartItem` (
    `id` VARCHAR(64) NOT NULL,
    `cartId` VARCHAR(64) NOT NULL,
    `lineKey` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `variantId` VARCHAR(64) NULL,
    `qty` INTEGER NOT NULL DEFAULT 1,
    `selectedOptionsJson` LONGTEXT NULL,
    `customizationJson` LONGTEXT NULL,
    `customizationHash` CHAR(64) COLLATE utf8mb4_bin NULL,
    `saveState` VARCHAR(191) NOT NULL DEFAULT 'IN_CART',
    `addedUnitPricePaise` INTEGER NOT NULL DEFAULT 0,
    `addedTotalPaise` INTEGER NOT NULL DEFAULT 0,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastUnitPricePaise` INTEGER NULL,
    `lastTotalPaise` INTEGER NULL,
    `productNameSnapshot` VARCHAR(255) NOT NULL,
    `variantNameSnapshot` VARCHAR(255) NULL,
    `skuSnapshot` VARCHAR(191) NOT NULL,
    `imageMediaIdSnapshot` VARCHAR(255) NULL,
    `note` VARCHAR(1000) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CartItem_cartId_saveState_position_idx`(`cartId`, `saveState`, `position`),
    INDEX `CartItem_productId_idx`(`productId`),
    UNIQUE INDEX `CartItem_cartId_lineKey_key`(`cartId`, `lineKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CartEvent` (
    `id` VARCHAR(64) NOT NULL,
    `cartId` VARCHAR(64) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `payloadJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CartEvent_cartId_createdAt_idx`(`cartId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Wishlist` (
    `id` VARCHAR(64) NOT NULL,
    `customerId` VARCHAR(64) NULL,
    `sessionId` VARCHAR(64) COLLATE utf8mb4_bin NULL,
    `name` VARCHAR(255) NOT NULL DEFAULT 'My Wishlist',
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `isPublic` BOOLEAN NOT NULL DEFAULT false,
    `shareToken` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `itemCount` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Wishlist_shareToken_key`(`shareToken`),
    INDEX `Wishlist_customerId_idx`(`customerId`),
    INDEX `Wishlist_sessionId_idx`(`sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WishlistItem` (
    `id` VARCHAR(64) NOT NULL,
    `wishlistId` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `variantId` VARCHAR(64) NULL,
    `selectedOptionsJson` LONGTEXT NULL,
    `lineKey` VARCHAR(191) NOT NULL,
    `priority` VARCHAR(64) NOT NULL DEFAULT 'NORMAL',
    `note` VARCHAR(1000) NULL,
    `addedPricePaise` INTEGER NOT NULL DEFAULT 0,
    `lastSeenPricePaise` INTEGER NULL,
    `priceDropNotifiedAt` DATETIME(3) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WishlistItem_productId_idx`(`productId`),
    UNIQUE INDEX `WishlistItem_wishlistId_lineKey_key`(`wishlistId`, `lineKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Address` (
    `id` VARCHAR(64) NOT NULL,
    `customerId` VARCHAR(64) NOT NULL,
    `label` VARCHAR(255) NULL,
    `type` VARCHAR(64) NOT NULL DEFAULT 'HOME',
    `usage` VARCHAR(64) NOT NULL DEFAULT 'BOTH',
    `fullName` VARCHAR(255) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `altPhone` VARCHAR(191) NULL,
    `line1` VARCHAR(1000) NOT NULL,
    `line2` VARCHAR(1000) NULL,
    `landmark` VARCHAR(1000) NULL,
    `city` VARCHAR(120) NOT NULL,
    `state` VARCHAR(64) NOT NULL,
    `stateCode` VARCHAR(64) NOT NULL,
    `pincode` VARCHAR(191) NOT NULL,
    `country` VARCHAR(64) NOT NULL DEFAULT 'IN',
    `isDefaultShipping` BOOLEAN NOT NULL DEFAULT false,
    `isDefaultBilling` BOOLEAN NOT NULL DEFAULT false,
    `deliveryInstructions` VARCHAR(1000) NULL,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `isVerified` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Address_customerId_idx`(`customerId`),
    INDEX `Address_pincode_idx`(`pincode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RecentlyViewed` (
    `id` VARCHAR(64) NOT NULL,
    `customerId` VARCHAR(191) NULL,
    `sessionId` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `productId` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(64) NULL,
    `viewCount` INTEGER NOT NULL DEFAULT 1,
    `viewedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RecentlyViewed_customerId_viewedAt_idx`(`customerId`, `viewedAt`),
    INDEX `RecentlyViewed_sessionId_viewedAt_idx`(`sessionId`, `viewedAt`),
    UNIQUE INDEX `RecentlyViewed_customerId_productId_key`(`customerId`, `productId`),
    UNIQUE INDEX `RecentlyViewed_sessionId_productId_key`(`sessionId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderSequence` (
    `id` VARCHAR(64) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `lastNumber` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrderSequence_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Order` (
    `id` VARCHAR(64) NOT NULL,
    `orderNumber` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(64) NULL,
    `cartId` VARCHAR(64) NULL,
    `isGuest` BOOLEAN NOT NULL DEFAULT false,
    `guestEmail` VARCHAR(191) NULL,
    `guestPhone` VARCHAR(32) NULL,
    `guestName` VARCHAR(255) NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'DRAFT',
    `paymentStatus` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `fulfillmentStatus` VARCHAR(64) NOT NULL DEFAULT 'UNFULFILLED',
    `channel` VARCHAR(64) NOT NULL DEFAULT 'WEB',
    `currency` VARCHAR(64) NOT NULL DEFAULT 'INR',
    `customerGroupCode` VARCHAR(64) NULL,
    `placeOfSupply` VARCHAR(64) NOT NULL,
    `sellerStateCode` VARCHAR(64) NOT NULL,
    `subtotalPaise` INTEGER NOT NULL,
    `discountPaise` INTEGER NOT NULL,
    `shippingPaise` INTEGER NOT NULL,
    `taxPaise` INTEGER NOT NULL,
    `cgstPaise` INTEGER NOT NULL DEFAULT 0,
    `sgstPaise` INTEGER NOT NULL DEFAULT 0,
    `igstPaise` INTEGER NOT NULL DEFAULT 0,
    `roundingPaise` INTEGER NOT NULL DEFAULT 0,
    `grandTotalPaise` INTEGER NOT NULL,
    `totalSavingsPaise` INTEGER NOT NULL DEFAULT 0,
    `paidPaise` INTEGER NOT NULL DEFAULT 0,
    `refundedPaise` INTEGER NOT NULL DEFAULT 0,
    `refundReservedPaise` INTEGER NOT NULL DEFAULT 0,
    `duePaise` INTEGER NOT NULL DEFAULT 0,
    `couponCode` VARCHAR(64) NULL,
    `appliedRuleIdsJson` LONGTEXT NULL,
    `breakdownJson` LONGTEXT NOT NULL,
    `pricingEngineVersion` VARCHAR(64) NOT NULL,
    `pricingContextHash` CHAR(64) COLLATE utf8mb4_bin NOT NULL,
    `customerNote` VARCHAR(1000) NULL,
    `internalNote` VARCHAR(1000) NULL,
    `giftMessage` VARCHAR(1000) NULL,
    `ipAddress` VARCHAR(45) NULL,
    `userAgent` VARCHAR(512) NULL,
    `referrer` VARCHAR(512) NULL,
    `utmJson` LONGTEXT NULL,
    `placedAt` DATETIME(3) NULL,
    `confirmedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(1000) NULL,
    `expiresAt` DATETIME(3) NULL,
    `estimatedDeliveryMinDays` INTEGER NULL,
    `estimatedDeliveryMaxDays` INTEGER NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Order_orderNumber_key`(`orderNumber`),
    INDEX `Order_customerId_createdAt_idx`(`customerId`, `createdAt`),
    INDEX `Order_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `Order_paymentStatus_idx`(`paymentStatus`),
    INDEX `Order_orderNumber_idx`(`orderNumber`),
    INDEX `Order_status_expiresAt_idx`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderItem` (
    `orderId` VARCHAR(64) NOT NULL,
    `id` VARCHAR(64) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `variantId` VARCHAR(64) NULL,
    `sku` VARCHAR(191) NOT NULL,
    `productName` VARCHAR(255) NOT NULL,
    `variantName` VARCHAR(255) NULL,
    `brandName` VARCHAR(255) NULL,
    `primaryCategoryPath` VARCHAR(255) NULL,
    `imageMediaId` VARCHAR(64) NULL,
    `imageUrlSnapshot` VARCHAR(255) NULL,
    `selectedOptionsJson` LONGTEXT NULL,
    `optionLabelsJson` LONGTEXT NULL,
    `customizationJson` LONGTEXT NULL,
    `customizationHash` CHAR(64) COLLATE utf8mb4_bin NULL,
    `qty` INTEGER NOT NULL,
    `unitPricePaise` INTEGER NOT NULL,
    `baseUnitPricePaise` INTEGER NOT NULL,
    `lineSubtotalPaise` INTEGER NOT NULL,
    `lineDiscountPaise` INTEGER NOT NULL DEFAULT 0,
    `taxablePaise` INTEGER NOT NULL,
    `taxPaise` INTEGER NOT NULL,
    `taxRateBp` INTEGER NOT NULL DEFAULT 0,
    `cgstPaise` INTEGER NOT NULL DEFAULT 0,
    `sgstPaise` INTEGER NOT NULL DEFAULT 0,
    `igstPaise` INTEGER NOT NULL DEFAULT 0,
    `hsnCode` VARCHAR(64) NULL,
    `lineTotalPaise` INTEGER NOT NULL,
    `componentsJson` LONGTEXT NOT NULL,
    `isMadeToOrder` BOOLEAN NOT NULL DEFAULT false,
    `leadTimeDays` INTEGER NULL,
    `weightGrams` INTEGER NULL,
    `fulfilledQty` INTEGER NOT NULL DEFAULT 0,
    `cancelledQty` INTEGER NOT NULL DEFAULT 0,
    `refundedQty` INTEGER NOT NULL DEFAULT 0,
    `refundedAmountPaise` INTEGER NOT NULL DEFAULT 0,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderItem_orderId_idx`(`orderId`),
    INDEX `OrderItem_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderAddress` (
    `id` VARCHAR(64) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `sourceAddressId` VARCHAR(64) NULL,
    `fullName` VARCHAR(255) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `altPhone` VARCHAR(191) NULL,
    `line1` VARCHAR(1000) NOT NULL,
    `line2` VARCHAR(1000) NULL,
    `landmark` VARCHAR(1000) NULL,
    `city` VARCHAR(120) NOT NULL,
    `state` VARCHAR(64) NOT NULL,
    `stateCode` VARCHAR(64) NOT NULL,
    `pincode` VARCHAR(16) NOT NULL,
    `country` VARCHAR(64) NOT NULL DEFAULT 'IN',
    `deliveryInstructions` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OrderAddress_orderId_type_key`(`orderId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderStatusHistory` (
    `id` VARCHAR(64) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `fromStatus` VARCHAR(64) NULL,
    `toStatus` VARCHAR(64) NOT NULL,
    `note` VARCHAR(1000) NULL,
    `actorType` VARCHAR(64) NOT NULL DEFAULT 'SYSTEM',
    `actorId` VARCHAR(64) NULL,
    `actorName` VARCHAR(255) NULL,
    `metaJson` LONGTEXT NULL,
    `isCustomerVisible` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderStatusHistory_orderId_createdAt_idx`(`orderId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Payment` (
    `id` VARCHAR(64) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `method` VARCHAR(64) NULL,
    `methodDetail` VARCHAR(255) NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `attemptNumber` INTEGER NOT NULL DEFAULT 1,
    `amountPaise` INTEGER NOT NULL,
    `capturedPaise` INTEGER NOT NULL DEFAULT 0,
    `refundedPaise` INTEGER NOT NULL DEFAULT 0,
    `feePaise` INTEGER NULL,
    `taxOnFeePaise` INTEGER NULL,
    `providerOrderId` VARCHAR(64) COLLATE utf8mb4_bin NULL,
    `providerPaymentId` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `providerSignature` VARCHAR(255) COLLATE utf8mb4_bin NULL,
    `currency` VARCHAR(64) NOT NULL DEFAULT 'INR',
    `authorizedAt` DATETIME(3) NULL,
    `capturedAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorDescription` TEXT NULL,
    `errorSource` VARCHAR(64) NULL,
    `errorStep` VARCHAR(64) NULL,
    `errorReason` VARCHAR(1000) NULL,
    `isTransferable` BOOLEAN NOT NULL DEFAULT true,
    `idempotencyKey` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `rawResponseJson` LONGTEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Payment_orderId_attemptNumber_idx`(`orderId`, `attemptNumber`),
    INDEX `Payment_status_idx`(`status`),
    UNIQUE INDEX `Payment_provider_providerPaymentId_key`(`provider`, `providerPaymentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SplitAccount` (
    `key` VARCHAR(191) NOT NULL,
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `providerAccountId` VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    `notes` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SplitAccount_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SplitRule` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `scope` VARCHAR(64) NOT NULL DEFAULT 'GLOBAL',
    `scopeEntityId` VARCHAR(64) NULL,
    `basis` VARCHAR(64) NOT NULL DEFAULT 'ORDER_TOTAL',
    `mode` VARCHAR(64) NOT NULL,
    `valuePaise` INTEGER NULL,
    `valueBp` INTEGER NULL,
    `recipientKey` VARCHAR(64) NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `minOrderPaise` INTEGER NULL,
    `maxTransferPaise` INTEGER NULL,
    `onHold` BOOLEAN NOT NULL DEFAULT false,
    `onHoldUntil` DATETIME(3) NULL,
    `notes` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SplitRule_code_key`(`code`),
    INDEX `SplitRule_scope_isActive_priority_idx`(`scope`, `isActive`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SplitAllocation` (
    `id` VARCHAR(64) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `paymentId` VARCHAR(64) NULL,
    `splitAccountId` VARCHAR(64) NOT NULL,
    `splitRuleId` VARCHAR(64) NULL,
    `orderItemId` VARCHAR(64) NULL,
    `amountPaise` INTEGER NOT NULL,
    `basisAmountPaise` INTEGER NOT NULL,
    `mode` VARCHAR(64) NOT NULL,
    `sequence` INTEGER NOT NULL DEFAULT 0,
    `isRemainder` BOOLEAN NOT NULL DEFAULT false,
    `note` VARCHAR(1000) NULL,
    `computedAtHash` CHAR(64) COLLATE utf8mb4_bin NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SplitAllocation_orderId_idx`(`orderId`),
    INDEX `SplitAllocation_paymentId_idx`(`paymentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaymentTransfer` (
    `id` VARCHAR(64) NOT NULL,
    `paymentId` VARCHAR(64) NOT NULL,
    `splitAllocationId` VARCHAR(64) NULL,
    `splitAccountId` VARCHAR(64) NOT NULL,
    `providerTransferId` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `amountPaise` INTEGER NOT NULL,
    `feePaise` INTEGER NULL,
    `taxPaise` INTEGER NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `onHold` BOOLEAN NOT NULL DEFAULT false,
    `onHoldUntil` DATETIME(3) NULL,
    `reversedPaise` INTEGER NOT NULL DEFAULT 0,
    `reversalReservedPaise` INTEGER NOT NULL DEFAULT 0,
    `settlementStatus` VARCHAR(64) NULL,
    `providerRecipientId` VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    `notesJson` LONGTEXT NULL,
    `rawResponseJson` LONGTEXT NULL,
    `processedAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorDescription` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PaymentTransfer_splitAllocationId_key`(`splitAllocationId`),
    UNIQUE INDEX `PaymentTransfer_providerTransferId_key`(`providerTransferId`),
    INDEX `PaymentTransfer_paymentId_idx`(`paymentId`),
    INDEX `PaymentTransfer_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Refund` (
    `id` VARCHAR(64) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `paymentId` VARCHAR(64) NOT NULL,
    `refundNumber` VARCHAR(191) NOT NULL,
    `amountPaise` INTEGER NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'REQUESTED',
    `reason` VARCHAR(1000) NOT NULL,
    `reasonNote` VARCHAR(1000) NULL,
    `speed` VARCHAR(64) NOT NULL DEFAULT 'NORMAL',
    `providerRefundId` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `isFullRefund` BOOLEAN NOT NULL DEFAULT false,
    `clientReference` VARCHAR(191) NULL,
    `executionLockedAt` DATETIME(3) NULL,
    `executionAttempt` INTEGER NOT NULL DEFAULT 0,
    `capacityReserved` BOOLEAN NOT NULL DEFAULT false,
    `capacityConfirmed` BOOLEAN NOT NULL DEFAULT false,
    `reversalStrategy` VARCHAR(64) NOT NULL DEFAULT 'EXPLICIT',
    `requestedById` VARCHAR(64) NULL,
    `requestedByType` VARCHAR(64) NOT NULL DEFAULT 'CUSTOMER',
    `approvedById` VARCHAR(64) NULL,
    `approvedAt` DATETIME(3) NULL,
    `processedAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorDescription` TEXT NULL,
    `restockRequested` BOOLEAN NOT NULL DEFAULT true,
    `restockedAt` DATETIME(3) NULL,
    `rawResponseJson` LONGTEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Refund_refundNumber_key`(`refundNumber`),
    UNIQUE INDEX `Refund_providerRefundId_key`(`providerRefundId`),
    UNIQUE INDEX `Refund_clientReference_key`(`clientReference`),
    INDEX `Refund_orderId_idx`(`orderId`),
    INDEX `Refund_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefundItem` (
    `id` VARCHAR(64) NOT NULL,
    `refundId` VARCHAR(64) NOT NULL,
    `orderItemId` VARCHAR(64) NOT NULL,
    `qty` INTEGER NOT NULL,
    `amountPaise` INTEGER NOT NULL,
    `taxPaise` INTEGER NOT NULL DEFAULT 0,

    INDEX `RefundItem_refundId_idx`(`refundId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TransferReversal` (
    `id` VARCHAR(64) NOT NULL,
    `paymentTransferId` VARCHAR(64) NOT NULL,
    `refundId` VARCHAR(64) NULL,
    `providerReversalId` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `amountPaise` INTEGER NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `processedAt` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorDescription` TEXT NULL,
    `rawResponseJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TransferReversal_providerReversalId_key`(`providerReversalId`),
    INDEX `TransferReversal_paymentTransferId_idx`(`paymentTransferId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Settlement` (
    `id` VARCHAR(64) NOT NULL,
    `provider` VARCHAR(64) NOT NULL,
    `providerSettlementId` VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
    `amountPaise` INTEGER NOT NULL,
    `feePaise` INTEGER NOT NULL DEFAULT 0,
    `taxPaise` INTEGER NOT NULL DEFAULT 0,
    `utr` VARCHAR(64) COLLATE utf8mb4_bin NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `settledAt` DATETIME(3) NULL,
    `rawResponseJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Settlement_providerSettlementId_key`(`providerSettlementId`),
    INDEX `Settlement_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SettlementEntry` (
    `id` VARCHAR(64) NOT NULL,
    `settlementId` VARCHAR(64) NOT NULL,
    `entityType` VARCHAR(64) NOT NULL,
    `entityId` VARCHAR(64) NOT NULL,
    `amountPaise` INTEGER NOT NULL,
    `feePaise` INTEGER NULL,
    `taxPaise` INTEGER NULL,

    INDEX `SettlementEntry_settlementId_idx`(`settlementId`),
    INDEX `SettlementEntry_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebhookEvent` (
    `id` VARCHAR(64) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `providerEventId` VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
    `eventType` VARCHAR(64) NOT NULL,
    `signatureValid` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(64) NOT NULL DEFAULT 'RECEIVED',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `payloadJson` LONGTEXT NOT NULL,
    `relatedEntityType` VARCHAR(64) NULL,
    `relatedEntityId` VARCHAR(64) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,
    `errorMessage` VARCHAR(1000) NULL,
    `processingLockedAt` DATETIME(3) NULL,

    INDEX `WebhookEvent_status_receivedAt_idx`(`status`, `receivedAt`),
    INDEX `WebhookEvent_eventType_idx`(`eventType`),
    UNIQUE INDEX `WebhookEvent_provider_providerEventId_key`(`provider`, `providerEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockReservation` (
    `id` VARCHAR(64) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `orderItemId` VARCHAR(64) NULL,
    `variantId` VARCHAR(64) NOT NULL,
    `qty` INTEGER NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'RESERVED',
    `reservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `releasedAt` DATETIME(3) NULL,
    `releaseReason` VARCHAR(1000) NULL,
    `inventoryLedgerIdOnConsume` VARCHAR(64) NULL,

    INDEX `StockReservation_orderId_idx`(`orderId`),
    INDEX `StockReservation_variantId_status_idx`(`variantId`, `status`),
    INDEX `StockReservation_status_expiresAt_idx`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CheckoutSession` (
    `id` VARCHAR(64) NOT NULL,
    `cartId` VARCHAR(64) NOT NULL,
    `customerId` VARCHAR(64) NULL,
    `sessionId` VARCHAR(64) COLLATE utf8mb4_bin NULL,
    `step` VARCHAR(64) NOT NULL DEFAULT 'CART',
    `orderId` VARCHAR(64) NULL,
    `shippingAddressId` VARCHAR(64) NULL,
    `billingAddressId` VARCHAR(64) NULL,
    `sameAsShipping` BOOLEAN NOT NULL DEFAULT true,
    `addressesJson` LONGTEXT NULL,
    `paymentProvider` VARCHAR(64) NULL,
    `paymentMethodHint` VARCHAR(64) NULL,
    `contactEmail` VARCHAR(191) NULL,
    `contactPhone` VARCHAR(32) NULL,
    `customerNote` VARCHAR(1000) NULL,
    `giftMessage` VARCHAR(1000) NULL,
    `quoteHash` CHAR(64) COLLATE utf8mb4_bin NOT NULL,
    `quotedTotalPaise` INTEGER NOT NULL,
    `quotedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'ACTIVE',
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CheckoutSession_cartId_idx`(`cartId`),
    INDEX `CheckoutSession_status_expiresAt_idx`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShippingProvider` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `driver` VARCHAR(64) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `capabilitiesJson` LONGTEXT NULL,
    `lastHealthyAt` DATETIME(3) NULL,
    `lastErrorAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `notes` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ShippingProvider_code_key`(`code`),
    INDEX `ShippingProvider_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShippingProviderConfig` (
    `id` VARCHAR(64) NOT NULL,
    `providerId` VARCHAR(64) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `value` TEXT NOT NULL,
    `isSecret` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ShippingProviderConfig_providerId_key_key`(`providerId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PickupLocation` (
    `id` VARCHAR(64) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `providerId` VARCHAR(64) NULL,
    `providerLocationId` VARCHAR(64) COLLATE utf8mb4_bin NULL,
    `contactName` VARCHAR(255) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `line1` VARCHAR(1000) NOT NULL,
    `line2` VARCHAR(1000) NULL,
    `city` VARCHAR(120) NOT NULL,
    `state` VARCHAR(64) NOT NULL,
    `stateCode` VARCHAR(64) NOT NULL,
    `pincode` VARCHAR(16) NOT NULL,
    `country` VARCHAR(64) NOT NULL DEFAULT 'IN',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PickupLocation_code_key`(`code`),
    INDEX `PickupLocation_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProviderOperation` (
    `id` VARCHAR(64) NOT NULL,
    `providerId` VARCHAR(64) NULL,
    `providerCode` VARCHAR(64) NOT NULL,
    `operation` VARCHAR(64) NOT NULL,
    `entityType` VARCHAR(64) NOT NULL,
    `entityId` VARCHAR(64) NOT NULL,
    `idempotencyKey` VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `attempt` INTEGER NOT NULL DEFAULT 1,
    `failureKind` VARCHAR(64) NULL,
    `errorMessage` VARCHAR(1000) NULL,
    `responseJson` LONGTEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    UNIQUE INDEX `ProviderOperation_idempotencyKey_key`(`idempotencyKey`),
    INDEX `ProviderOperation_entityType_entityId_idx`(`entityType`, `entityId`),
    INDEX `ProviderOperation_status_startedAt_idx`(`status`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Shipment` (
    `id` VARCHAR(64) NOT NULL,
    `shipmentNumber` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `returnRequestId` VARCHAR(64) NULL,
    `direction` VARCHAR(64) NOT NULL DEFAULT 'FORWARD',
    `status` VARCHAR(64) NOT NULL DEFAULT 'DRAFT',
    `providerId` VARCHAR(64) NULL,
    `providerCode` VARCHAR(191) NOT NULL DEFAULT 'MANUAL',
    `providerOrderId` VARCHAR(64) COLLATE utf8mb4_bin NULL,
    `providerShipmentId` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `providerCourierId` VARCHAR(64) COLLATE utf8mb4_bin NULL,
    `providerCourierName` VARCHAR(255) NULL,
    `awbNumber` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `providerStatus` VARCHAR(64) NULL,
    `providerStatusCode` VARCHAR(64) NULL,
    `providerCreatedAt` DATETIME(3) NULL,
    `providerUpdatedAt` DATETIME(3) NULL,
    `providerMetadataJson` LONGTEXT NULL,
    `isCod` BOOLEAN NOT NULL DEFAULT false,
    `codAmountPaise` INTEGER NOT NULL DEFAULT 0,
    `shippingCostPaise` INTEGER NOT NULL DEFAULT 0,
    `weightGrams` INTEGER NOT NULL DEFAULT 0,
    `lengthMm` INTEGER NOT NULL DEFAULT 0,
    `widthMm` INTEGER NOT NULL DEFAULT 0,
    `heightMm` INTEGER NOT NULL DEFAULT 0,
    `packageCount` INTEGER NOT NULL DEFAULT 1,
    `packagingType` VARCHAR(64) NOT NULL DEFAULT 'BOX',
    `declaredValuePaise` INTEGER NOT NULL DEFAULT 0,
    `pickupLocationId` VARCHAR(64) NULL,
    `pickupScheduledAt` DATETIME(3) NULL,
    `pickupTokenNumber` VARCHAR(64) COLLATE utf8mb4_bin NULL,
    `estimatedDeliveryAt` DATETIME(3) NULL,
    `shippedAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(1000) NULL,
    `labelDocumentId` VARCHAR(64) NULL,
    `manifestDocumentId` VARCHAR(64) NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `internalNote` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Shipment_shipmentNumber_key`(`shipmentNumber`),
    INDEX `Shipment_orderId_idx`(`orderId`),
    INDEX `Shipment_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `Shipment_awbNumber_idx`(`awbNumber`),
    INDEX `Shipment_providerCode_providerOrderId_idx`(`providerCode`, `providerOrderId`),
    UNIQUE INDEX `Shipment_providerCode_providerShipmentId_key`(`providerCode`, `providerShipmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShipmentItem` (
    `id` VARCHAR(64) NOT NULL,
    `shipmentId` VARCHAR(64) NOT NULL,
    `orderItemId` VARCHAR(64) NOT NULL,
    `qty` INTEGER NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `productName` VARCHAR(255) NOT NULL,
    `variantName` VARCHAR(255) NULL,

    INDEX `ShipmentItem_orderItemId_idx`(`orderItemId`),
    UNIQUE INDEX `ShipmentItem_shipmentId_orderItemId_key`(`shipmentId`, `orderItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShipmentEvent` (
    `id` VARCHAR(64) NOT NULL,
    `shipmentId` VARCHAR(64) NOT NULL,
    `status` VARCHAR(64) NULL,
    `providerStatus` VARCHAR(64) NULL,
    `providerStatusCode` VARCHAR(64) NULL,
    `description` TEXT NOT NULL,
    `location` VARCHAR(255) NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT 'SYSTEM',
    `dedupeKey` VARCHAR(191) NULL,
    `isCustomerVisible` BOOLEAN NOT NULL DEFAULT true,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ShipmentEvent_shipmentId_occurredAt_idx`(`shipmentId`, `occurredAt`),
    UNIQUE INDEX `ShipmentEvent_shipmentId_dedupeKey_key`(`shipmentId`, `dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NdrRecord` (
    `id` VARCHAR(64) NOT NULL,
    `shipmentId` VARCHAR(64) NOT NULL,
    `reason` VARCHAR(1000) NOT NULL,
    `reasonCode` VARCHAR(64) NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 1,
    `status` VARCHAR(64) NOT NULL DEFAULT 'OPEN',
    `actionTaken` VARCHAR(64) NULL,
    `actionNote` VARCHAR(1000) NULL,
    `actedById` VARCHAR(64) NULL,
    `actedAt` DATETIME(3) NULL,
    `providerNdrId` VARCHAR(191) COLLATE utf8mb4_bin NULL,
    `raisedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NdrRecord_status_raisedAt_idx`(`status`, `raisedAt`),
    UNIQUE INDEX `NdrRecord_shipmentId_providerNdrId_key`(`shipmentId`, `providerNdrId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReturnRequest` (
    `id` VARCHAR(64) NOT NULL,
    `returnNumber` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `customerId` VARCHAR(64) NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'REQUESTED',
    `reason` VARCHAR(1000) NOT NULL,
    `reasonNote` VARCHAR(1000) NULL,
    `resolution` VARCHAR(64) NOT NULL DEFAULT 'REFUND',
    `isExchange` BOOLEAN NOT NULL DEFAULT false,
    `requestedAmountPaise` INTEGER NOT NULL DEFAULT 0,
    `approvedAmountPaise` INTEGER NOT NULL DEFAULT 0,
    `refundedAmountPaise` INTEGER NOT NULL DEFAULT 0,
    `refundId` VARCHAR(64) NULL,
    `requestedByType` VARCHAR(64) NOT NULL DEFAULT 'CUSTOMER',
    `requestedById` VARCHAR(64) NULL,
    `approvedById` VARCHAR(64) NULL,
    `approvedAt` DATETIME(3) NULL,
    `rejectedReason` VARCHAR(1000) NULL,
    `receivedAt` DATETIME(3) NULL,
    `inspectedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `internalNote` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReturnRequest_returnNumber_key`(`returnNumber`),
    INDEX `ReturnRequest_orderId_idx`(`orderId`),
    INDEX `ReturnRequest_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `ReturnRequest_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReturnItem` (
    `id` VARCHAR(64) NOT NULL,
    `returnRequestId` VARCHAR(64) NOT NULL,
    `orderItemId` VARCHAR(64) NOT NULL,
    `qtyRequested` INTEGER NOT NULL,
    `qtyApproved` INTEGER NOT NULL DEFAULT 0,
    `qtyReceived` INTEGER NOT NULL DEFAULT 0,
    `qtyRestocked` INTEGER NOT NULL DEFAULT 0,
    `condition` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `inspectionNote` VARCHAR(1000) NULL,
    `restockRequested` BOOLEAN NOT NULL DEFAULT false,
    `unitPricePaise` INTEGER NOT NULL,
    `refundableAmountPaise` INTEGER NOT NULL DEFAULT 0,
    `refundableTaxPaise` INTEGER NOT NULL DEFAULT 0,
    `sku` VARCHAR(191) NOT NULL,
    `productName` VARCHAR(255) NOT NULL,
    `variantName` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReturnItem_orderItemId_idx`(`orderItemId`),
    UNIQUE INDEX `ReturnItem_returnRequestId_orderItemId_key`(`returnRequestId`, `orderItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DocumentSequence` (
    `id` VARCHAR(64) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `prefix` VARCHAR(64) NOT NULL,
    `lastNumber` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DocumentSequence_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderDocument` (
    `id` VARCHAR(64) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `shipmentId` VARCHAR(64) NULL,
    `returnRequestId` VARCHAR(64) NULL,
    `refundId` VARCHAR(191) NULL,
    `type` VARCHAR(64) NOT NULL,
    `documentNumber` VARCHAR(191) NULL,
    `storageKey` VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
    `mimeType` VARCHAR(64) NOT NULL DEFAULT 'application/pdf',
    `sizeBytes` INTEGER NOT NULL DEFAULT 0,
    `checksum` CHAR(64) COLLATE utf8mb4_bin NOT NULL,
    `totalPaise` INTEGER NOT NULL DEFAULT 0,
    `taxPaise` INTEGER NOT NULL DEFAULT 0,
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OrderDocument_refundId_key`(`refundId`),
    UNIQUE INDEX `OrderDocument_documentNumber_key`(`documentNumber`),
    INDEX `OrderDocument_orderId_type_idx`(`orderId`, `type`),
    INDEX `OrderDocument_shipmentId_idx`(`shipmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotificationTemplate` (
    `id` VARCHAR(64) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(255) NULL,
    `body` TEXT NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NotificationTemplate_event_channel_key`(`event`, `channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotificationLog` (
    `id` VARCHAR(64) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(64) NOT NULL,
    `recipient` VARCHAR(255) NOT NULL,
    `subject` VARCHAR(255) NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'QUEUED',
    `error` TEXT NULL,
    `orderId` VARCHAR(64) NULL,
    `shipmentId` VARCHAR(64) NULL,
    `returnRequestId` VARCHAR(64) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `NotificationLog_event_createdAt_idx`(`event`, `createdAt`),
    INDEX `NotificationLog_orderId_idx`(`orderId`),
    INDEX `NotificationLog_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderNote` (
    `id` VARCHAR(64) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `body` TEXT NOT NULL,
    `isCustomerVisible` BOOLEAN NOT NULL DEFAULT false,
    `authorType` VARCHAR(64) NOT NULL DEFAULT 'ADMIN',
    `authorId` VARCHAR(64) NULL,
    `authorName` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderNote_orderId_createdAt_idx`(`orderId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Page` (
    `id` VARCHAR(64) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `type` VARCHAR(64) NOT NULL DEFAULT 'STANDARD',
    `status` VARCHAR(64) NOT NULL DEFAULT 'DRAFT',
    `template` VARCHAR(64) NULL,
    `excerpt` TEXT NULL,
    `heroMediaId` VARCHAR(64) NULL,
    `ogMediaId` VARCHAR(64) NULL,
    `seoTitle` VARCHAR(255) NULL,
    `seoDescription` TEXT NULL,
    `seoKeywords` TEXT NULL,
    `canonicalUrl` VARCHAR(255) NULL,
    `noIndex` BOOLEAN NOT NULL DEFAULT false,
    `publishedAt` DATETIME(3) NULL,
    `scheduledAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `authorId` VARCHAR(64) NULL,
    `lastEditedById` VARCHAR(64) NULL,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `viewCount` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Page_slug_key`(`slug`),
    INDEX `Page_status_publishedAt_idx`(`status`, `publishedAt`),
    INDEX `Page_type_idx`(`type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PageBlock` (
    `id` VARCHAR(64) NOT NULL,
    `pageId` VARCHAR(64) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `deviceVisibility` VARCHAR(64) NOT NULL DEFAULT 'ALL',
    `configJson` LONGTEXT NOT NULL,
    `rawConfigJson` LONGTEXT NULL,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `anchorId` VARCHAR(64) NULL,
    `cssClass` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PageBlock_pageId_position_idx`(`pageId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PageRevision` (
    `id` VARCHAR(64) NOT NULL,
    `pageId` VARCHAR(64) NOT NULL,
    `version` INTEGER NOT NULL,
    `snapshotJson` LONGTEXT NOT NULL,
    `editedById` VARCHAR(64) NULL,
    `editedByName` VARCHAR(255) NULL,
    `note` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PageRevision_pageId_createdAt_idx`(`pageId`, `createdAt`),
    UNIQUE INDEX `PageRevision_pageId_version_key`(`pageId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Banner` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `placement` VARCHAR(191) NOT NULL,
    `mediaId` VARCHAR(64) NULL,
    `mobileMediaId` VARCHAR(64) NULL,
    `altText` VARCHAR(1000) NULL,
    `headline` VARCHAR(255) NULL,
    `subheadline` VARCHAR(500) NULL,
    `ctaLabel` VARCHAR(255) NULL,
    `ctaUrl` VARCHAR(255) NULL,
    `ctaStyle` VARCHAR(64) NULL,
    `backgroundHex` VARCHAR(16) NULL,
    `textHex` VARCHAR(16) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `deviceVisibility` VARCHAR(64) NOT NULL DEFAULT 'ALL',
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `targetCategoryIdsJson` LONGTEXT NULL,
    `targetCollectionIdsJson` LONGTEXT NULL,
    `impressionCount` INTEGER NOT NULL DEFAULT 0,
    `clickCount` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Banner_placement_isActive_position_idx`(`placement`, `isActive`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FaqCategory` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `iconMediaId` VARCHAR(64) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `FaqCategory_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Faq` (
    `id` VARCHAR(64) NOT NULL,
    `faqCategoryId` VARCHAR(64) NULL,
    `question` VARCHAR(1000) NOT NULL,
    `answer` TEXT NOT NULL,
    `visibility` VARCHAR(191) NOT NULL DEFAULT 'GLOBAL',
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `targetProductIdsJson` LONGTEXT NULL,
    `targetCategoryIdsJson` LONGTEXT NULL,
    `helpfulYes` INTEGER NOT NULL DEFAULT 0,
    `helpfulNo` INTEGER NOT NULL DEFAULT 0,
    `viewCount` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Faq_visibility_isActive_position_idx`(`visibility`, `isActive`, `position`),
    INDEX `Faq_faqCategoryId_position_idx`(`faqCategoryId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HelpCategory` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `iconMediaId` VARCHAR(64) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `parentId` VARCHAR(64) NULL,
    `path` VARCHAR(255) NOT NULL,
    `depth` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `HelpCategory_slug_key`(`slug`),
    INDEX `HelpCategory_parentId_position_idx`(`parentId`, `position`),
    INDEX `HelpCategory_path_idx`(`path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HelpArticle` (
    `id` VARCHAR(64) NOT NULL,
    `helpCategoryId` VARCHAR(64) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `excerpt` TEXT NULL,
    `bodyMarkdown` TEXT NOT NULL,
    `bodyHtml` TEXT NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'DRAFT',
    `position` INTEGER NOT NULL DEFAULT 0,
    `viewCount` INTEGER NOT NULL DEFAULT 0,
    `helpfulYes` INTEGER NOT NULL DEFAULT 0,
    `helpfulNo` INTEGER NOT NULL DEFAULT 0,
    `relatedArticleIdsJson` LONGTEXT NULL,
    `seoTitle` VARCHAR(255) NULL,
    `seoDescription` TEXT NULL,
    `publishedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `HelpArticle_slug_key`(`slug`),
    INDEX `HelpArticle_helpCategoryId_position_idx`(`helpCategoryId`, `position`),
    INDEX `HelpArticle_status_publishedAt_idx`(`status`, `publishedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Testimonial` (
    `id` VARCHAR(64) NOT NULL,
    `authorName` VARCHAR(255) NOT NULL,
    `authorLocation` VARCHAR(255) NULL,
    `authorRole` VARCHAR(64) NULL,
    `avatarMediaId` VARCHAR(64) NULL,
    `quote` TEXT NOT NULL,
    `ratingBp` INTEGER NULL,
    `productId` VARCHAR(64) NULL,
    `mediaIdsJson` LONGTEXT NULL,
    `isFeatured` BOOLEAN NOT NULL DEFAULT false,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `capturedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Testimonial_isFeatured_isActive_position_idx`(`isFeatured`, `isActive`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StoreLocation` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `addressLine1` VARCHAR(1000) NOT NULL,
    `addressLine2` VARCHAR(1000) NULL,
    `city` VARCHAR(120) NOT NULL,
    `state` VARCHAR(64) NOT NULL,
    `stateCode` VARCHAR(64) NOT NULL,
    `pincode` VARCHAR(16) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `mapsUrl` VARCHAR(255) NULL,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `openingHoursJson` LONGTEXT NULL,
    `mediaIdsJson` LONGTEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isFlagship` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `StoreLocation_slug_key`(`slug`),
    INDEX `StoreLocation_isActive_position_idx`(`isActive`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnnouncementBar` (
    `id` VARCHAR(64) NOT NULL,
    `message` VARCHAR(1000) NOT NULL,
    `linkUrl` VARCHAR(255) NULL,
    `linkLabel` VARCHAR(255) NULL,
    `backgroundHex` VARCHAR(16) NULL,
    `textHex` VARCHAR(16) NULL,
    `isDismissible` BOOLEAN NOT NULL DEFAULT true,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `position` INTEGER NOT NULL DEFAULT 0,
    `deviceVisibility` VARCHAR(64) NOT NULL DEFAULT 'ALL',
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `AnnouncementBar_isActive_position_idx`(`isActive`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ContentView` (
    `id` VARCHAR(64) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `dayKey` VARCHAR(191) NOT NULL,
    `viewCount` INTEGER NOT NULL DEFAULT 0,

    INDEX `ContentView_entityType_dayKey_idx`(`entityType`, `dayKey`),
    UNIQUE INDEX `ContentView_entityType_entityId_dayKey_key`(`entityType`, `entityId`, `dayKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Media` ADD CONSTRAINT `Media_folderId_fkey` FOREIGN KEY (`folderId`) REFERENCES `MediaFolder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MediaFolder` ADD CONSTRAINT `MediaFolder_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `MediaFolder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MediaUsage` ADD CONSTRAINT `MediaUsage_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `Media`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MediaVariant` ADD CONSTRAINT `MediaVariant_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `Media`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Category` ADD CONSTRAINT `Category_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `Category`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Attribute` ADD CONSTRAINT `Attribute_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `AttributeGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttributeValue` ADD CONSTRAINT `AttributeValue_attributeId_fkey` FOREIGN KEY (`attributeId`) REFERENCES `Attribute`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CategoryAttribute` ADD CONSTRAINT `CategoryAttribute_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CategoryAttribute` ADD CONSTRAINT `CategoryAttribute_attributeId_fkey` FOREIGN KEY (`attributeId`) REFERENCES `Attribute`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Product` ADD CONSTRAINT `Product_brandId_fkey` FOREIGN KEY (`brandId`) REFERENCES `Brand`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Product` ADD CONSTRAINT `Product_taxClassId_fkey` FOREIGN KEY (`taxClassId`) REFERENCES `TaxClass`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductCategory` ADD CONSTRAINT `ProductCategory_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductCategory` ADD CONSTRAINT `ProductCategory_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductAttributeValue` ADD CONSTRAINT `ProductAttributeValue_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductAttributeValue` ADD CONSTRAINT `ProductAttributeValue_attributeId_fkey` FOREIGN KEY (`attributeId`) REFERENCES `Attribute`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductAttributeValue` ADD CONSTRAINT `ProductAttributeValue_attributeValueId_fkey` FOREIGN KEY (`attributeValueId`) REFERENCES `AttributeValue`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductVariant` ADD CONSTRAINT `ProductVariant_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VariantAttributeValue` ADD CONSTRAINT `VariantAttributeValue_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VariantAttributeValue` ADD CONSTRAINT `VariantAttributeValue_attributeId_fkey` FOREIGN KEY (`attributeId`) REFERENCES `Attribute`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VariantAttributeValue` ADD CONSTRAINT `VariantAttributeValue_attributeValueId_fkey` FOREIGN KEY (`attributeValueId`) REFERENCES `AttributeValue`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductMedia` ADD CONSTRAINT `ProductMedia_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductMedia` ADD CONSTRAINT `ProductMedia_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `Media`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductMedia` ADD CONSTRAINT `ProductMedia_attributeValueId_fkey` FOREIGN KEY (`attributeValueId`) REFERENCES `AttributeValue`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductMedia` ADD CONSTRAINT `ProductMedia_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CollectionProduct` ADD CONSTRAINT `CollectionProduct_collectionId_fkey` FOREIGN KEY (`collectionId`) REFERENCES `Collection`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CollectionProduct` ADD CONSTRAINT `CollectionProduct_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InventoryLedger` ADD CONSTRAINT `InventoryLedger_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductRelation` ADD CONSTRAINT `ProductRelation_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductRelation` ADD CONSTRAINT `ProductRelation_relatedProductId_fkey` FOREIGN KEY (`relatedProductId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerGroupMember` ADD CONSTRAINT `CustomerGroupMember_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `CustomerGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PriceList` ADD CONSTRAINT `PriceList_customerGroupId_fkey` FOREIGN KEY (`customerGroupId`) REFERENCES `CustomerGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PriceListItem` ADD CONSTRAINT `PriceListItem_priceListId_fkey` FOREIGN KEY (`priceListId`) REFERENCES `PriceList`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TierPrice` ADD CONSTRAINT `TierPrice_customerGroupId_fkey` FOREIGN KEY (`customerGroupId`) REFERENCES `CustomerGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CouponRedemption` ADD CONSTRAINT `CouponRedemption_couponId_fkey` FOREIGN KEY (`couponId`) REFERENCES `Coupon`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShippingPincode` ADD CONSTRAINT `ShippingPincode_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `ShippingZone`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShippingPincodeRange` ADD CONSTRAINT `ShippingPincodeRange_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `ShippingZone`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShippingRate` ADD CONSTRAINT `ShippingRate_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `ShippingZone`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NavigationItem` ADD CONSTRAINT `NavigationItem_menuId_fkey` FOREIGN KEY (`menuId`) REFERENCES `NavigationMenu`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NavigationItem` ADD CONSTRAINT `NavigationItem_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `NavigationItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NavigationItem` ADD CONSTRAINT `NavigationItem_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NavigationItem` ADD CONSTRAINT `NavigationItem_collectionId_fkey` FOREIGN KEY (`collectionId`) REFERENCES `Collection`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RolePermission` ADD CONSTRAINT `RolePermission_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RolePermission` ADD CONSTRAINT `RolePermission_permissionId_fkey` FOREIGN KEY (`permissionId`) REFERENCES `Permission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminUserRole` ADD CONSTRAINT `AdminUserRole_adminUserId_fkey` FOREIGN KEY (`adminUserId`) REFERENCES `AdminUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminUserRole` ADD CONSTRAINT `AdminUserRole_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Customer` ADD CONSTRAINT `Customer_defaultAddressId_fkey` FOREIGN KEY (`defaultAddressId`) REFERENCES `Address`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductStat` ADD CONSTRAINT `ProductStat_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CartItem` ADD CONSTRAINT `CartItem_cartId_fkey` FOREIGN KEY (`cartId`) REFERENCES `Cart`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CartEvent` ADD CONSTRAINT `CartEvent_cartId_fkey` FOREIGN KEY (`cartId`) REFERENCES `Cart`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WishlistItem` ADD CONSTRAINT `WishlistItem_wishlistId_fkey` FOREIGN KEY (`wishlistId`) REFERENCES `Wishlist`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Address` ADD CONSTRAINT `Address_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderItem` ADD CONSTRAINT `OrderItem_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderAddress` ADD CONSTRAINT `OrderAddress_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderStatusHistory` ADD CONSTRAINT `OrderStatusHistory_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SplitAllocation` ADD CONSTRAINT `SplitAllocation_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SplitAllocation` ADD CONSTRAINT `SplitAllocation_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SplitAllocation` ADD CONSTRAINT `SplitAllocation_splitAccountId_fkey` FOREIGN KEY (`splitAccountId`) REFERENCES `SplitAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SplitAllocation` ADD CONSTRAINT `SplitAllocation_splitRuleId_fkey` FOREIGN KEY (`splitRuleId`) REFERENCES `SplitRule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentTransfer` ADD CONSTRAINT `PaymentTransfer_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentTransfer` ADD CONSTRAINT `PaymentTransfer_splitAllocationId_fkey` FOREIGN KEY (`splitAllocationId`) REFERENCES `SplitAllocation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentTransfer` ADD CONSTRAINT `PaymentTransfer_splitAccountId_fkey` FOREIGN KEY (`splitAccountId`) REFERENCES `SplitAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefundItem` ADD CONSTRAINT `RefundItem_refundId_fkey` FOREIGN KEY (`refundId`) REFERENCES `Refund`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefundItem` ADD CONSTRAINT `RefundItem_orderItemId_fkey` FOREIGN KEY (`orderItemId`) REFERENCES `OrderItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransferReversal` ADD CONSTRAINT `TransferReversal_paymentTransferId_fkey` FOREIGN KEY (`paymentTransferId`) REFERENCES `PaymentTransfer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransferReversal` ADD CONSTRAINT `TransferReversal_refundId_fkey` FOREIGN KEY (`refundId`) REFERENCES `Refund`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SettlementEntry` ADD CONSTRAINT `SettlementEntry_settlementId_fkey` FOREIGN KEY (`settlementId`) REFERENCES `Settlement`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockReservation` ADD CONSTRAINT `StockReservation_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockReservation` ADD CONSTRAINT `StockReservation_orderItemId_fkey` FOREIGN KEY (`orderItemId`) REFERENCES `OrderItem`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShippingProviderConfig` ADD CONSTRAINT `ShippingProviderConfig_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `ShippingProvider`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PickupLocation` ADD CONSTRAINT `PickupLocation_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `ShippingProvider`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProviderOperation` ADD CONSTRAINT `ProviderOperation_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `ShippingProvider`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Shipment` ADD CONSTRAINT `Shipment_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Shipment` ADD CONSTRAINT `Shipment_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `ShippingProvider`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Shipment` ADD CONSTRAINT `Shipment_pickupLocationId_fkey` FOREIGN KEY (`pickupLocationId`) REFERENCES `PickupLocation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Shipment` ADD CONSTRAINT `Shipment_returnRequestId_fkey` FOREIGN KEY (`returnRequestId`) REFERENCES `ReturnRequest`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShipmentItem` ADD CONSTRAINT `ShipmentItem_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `Shipment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShipmentItem` ADD CONSTRAINT `ShipmentItem_orderItemId_fkey` FOREIGN KEY (`orderItemId`) REFERENCES `OrderItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShipmentEvent` ADD CONSTRAINT `ShipmentEvent_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `Shipment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NdrRecord` ADD CONSTRAINT `NdrRecord_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `Shipment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReturnRequest` ADD CONSTRAINT `ReturnRequest_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReturnItem` ADD CONSTRAINT `ReturnItem_returnRequestId_fkey` FOREIGN KEY (`returnRequestId`) REFERENCES `ReturnRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReturnItem` ADD CONSTRAINT `ReturnItem_orderItemId_fkey` FOREIGN KEY (`orderItemId`) REFERENCES `OrderItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderDocument` ADD CONSTRAINT `OrderDocument_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderDocument` ADD CONSTRAINT `OrderDocument_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `Shipment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderNote` ADD CONSTRAINT `OrderNote_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PageBlock` ADD CONSTRAINT `PageBlock_pageId_fkey` FOREIGN KEY (`pageId`) REFERENCES `Page`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PageRevision` ADD CONSTRAINT `PageRevision_pageId_fkey` FOREIGN KEY (`pageId`) REFERENCES `Page`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Faq` ADD CONSTRAINT `Faq_faqCategoryId_fkey` FOREIGN KEY (`faqCategoryId`) REFERENCES `FaqCategory`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HelpCategory` ADD CONSTRAINT `HelpCategory_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `HelpCategory`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HelpArticle` ADD CONSTRAINT `HelpArticle_helpCategoryId_fkey` FOREIGN KEY (`helpCategoryId`) REFERENCES `HelpCategory`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
