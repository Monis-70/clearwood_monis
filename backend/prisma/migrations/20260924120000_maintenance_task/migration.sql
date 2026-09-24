-- Prompt 5: leased periodic maintenance (docs/DB_MIGRATION_PLAN.md section 4c).
--
-- One row per job. listingReconciler takes the row's lease with a compare-and-set UPDATE, so
-- however many PM2 workers tick, one of them does the work; a holder that dies simply lets the
-- lease expire. No rows are seeded: the job creates its own on first use.

-- CreateTable
CREATE TABLE `MaintenanceTask` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `leaseOwner` VARCHAR(191) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `watermarkAt` DATETIME(3) NULL,
    `rebuildRequestedAt` DATETIME(3) NULL,
    `lastRebuiltAt` DATETIME(3) NULL,
    `lastStartedAt` DATETIME(3) NULL,
    `lastCompletedAt` DATETIME(3) NULL,
    `lastError` VARCHAR(1000) NULL,
    `runCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MaintenanceTask_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
