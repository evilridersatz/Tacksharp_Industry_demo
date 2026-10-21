-- Pilot completion: dispatch details, product unit cost (for gross margin), collections notes + reminders,
-- expenses, and content revision history (AI / template / manual drafts).
-- ADDITIVE ONLY: four nullable columns on existing tables and three new tables. No existing row is changed or deleted.
-- Idempotent (IF NOT EXISTS). Requires 20261016 (SalesOrder, TextileProduct), 20261018 (Invoice), 20261019 (ContentItem).
-- Back up first:  mysqldump tacksharp > backup.sql   then:  npx prisma migrate deploy

ALTER TABLE `SalesOrder` ADD COLUMN IF NOT EXISTS `dispatchedAt` DATETIME(3) NULL;
ALTER TABLE `SalesOrder` ADD COLUMN IF NOT EXISTS `courier` VARCHAR(191) NULL;
ALTER TABLE `SalesOrder` ADD COLUMN IF NOT EXISTS `trackingRef` VARCHAR(191) NULL;
ALTER TABLE `TextileProduct` ADD COLUMN IF NOT EXISTS `unitCost` DECIMAL(12, 2) NULL;

CREATE TABLE IF NOT EXISTS `ContentRevision` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `contentItemId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `source` VARCHAR(191) NOT NULL,
    `model` VARCHAR(191) NULL,
    `language` VARCHAR(191) NULL,
    `inputTokens` INTEGER NULL,
    `outputTokens` INTEGER NULL,
    `removed` JSON NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ContentRevision_organizationId_contentItemId_createdAt_idx`(`organizationId`, `contentItemId`, `createdAt`),
    INDEX `ContentRevision_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `ContentRevision_contentItemId_fkey`(`contentItemId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `ContentRevision_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ContentRevision_contentItemId_fkey` FOREIGN KEY (`contentItemId`) REFERENCES `ContentItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `CollectionNote` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `invoiceId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `note` TEXT NULL,
    `promisedAmount` DECIMAL(14, 2) NULL,
    `promisedDate` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `approvalId` VARCHAR(191) NULL,
    `followUpId` VARCHAR(191) NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CollectionNote_organizationId_invoiceId_createdAt_idx`(`organizationId`, `invoiceId`, `createdAt`),
    INDEX `CollectionNote_organizationId_type_status_idx`(`organizationId`, `type`, `status`),
    INDEX `CollectionNote_invoiceId_fkey`(`invoiceId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `CollectionNote_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `CollectionNote_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Expense` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `spentOn` DATETIME(3) NOT NULL,
    `category` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'INR',
    `vendor` VARCHAR(191) NULL,
    `reference` VARCHAR(191) NULL,
    `referenceKey` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'recorded',
    `voidReason` TEXT NULL,
    `recordedBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Expense_organizationId_spentOn_idx`(`organizationId`, `spentOn`),
    INDEX `Expense_organizationId_referenceKey_idx`(`organizationId`, `referenceKey`),
    PRIMARY KEY (`id`),
    CONSTRAINT `Expense_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
