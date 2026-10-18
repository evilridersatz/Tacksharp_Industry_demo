-- Marketing agent: customer segments, campaign briefs / drafts, approval-gated WhatsApp campaigns, campaign recipients
-- (delivery + reply tracking, attribution) and the content calendar.
-- ADDITIVE ONLY: one nullable column (Customer.tags) and four new tables. No existing row is changed or deleted.
-- Idempotent (IF NOT EXISTS). Back up first:  mysqldump tacksharp > backup.sql   then:  npx prisma migrate deploy

ALTER TABLE `Customer` ADD COLUMN IF NOT EXISTS `tags` JSON NULL;

CREATE TABLE IF NOT EXISTS `MarketingSegment` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(500) NULL,
    `rules` JSON NOT NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MarketingSegment_organizationId_name_key`(`organizationId`, `name`),
    PRIMARY KEY (`id`),
    CONSTRAINT `MarketingSegment_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `MarketingCampaign` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `objective` VARCHAR(500) NULL,
    `occasion` VARCHAR(191) NULL,
    `channel` VARCHAR(191) NOT NULL DEFAULT 'whatsapp',
    `segmentId` VARCHAR(191) NULL,
    `brief` JSON NULL,
    `templateName` VARCHAR(191) NULL,
    `templateLanguage` VARCHAR(191) NULL,
    `templateParams` JSON NULL,
    `headerImageUrl` VARCHAR(1000) NULL,
    `previewText` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
    `scheduledAt` DATETIME(3) NULL,
    `approvedHash` VARCHAR(64) NULL,
    `approvalId` VARCHAR(191) NULL,
    `taskId` VARCHAR(191) NULL,
    `estimatedRecipients` INTEGER NULL,
    `estimatedCost` DECIMAL(10, 2) NULL,
    `simulated` BOOLEAN NOT NULL DEFAULT false,
    `createdBy` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MarketingCampaign_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `MarketingCampaign_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `MarketingCampaign_segmentId_fkey`(`segmentId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `MarketingCampaign_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `MarketingCampaign_segmentId_fkey` FOREIGN KEY (`segmentId`) REFERENCES `MarketingSegment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `CampaignRecipient` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'queued',
    `reason` VARCHAR(500) NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `leadId` VARCHAR(191) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `sentAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `readAt` DATETIME(3) NULL,
    `repliedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CampaignRecipient_campaignId_customerId_key`(`campaignId`, `customerId`),
    INDEX `CampaignRecipient_organizationId_providerMessageId_idx`(`organizationId`, `providerMessageId`),
    INDEX `CampaignRecipient_organizationId_customerId_sentAt_idx`(`organizationId`, `customerId`, `sentAt`),
    INDEX `CampaignRecipient_customerId_fkey`(`customerId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `CampaignRecipient_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `CampaignRecipient_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `MarketingCampaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `CampaignRecipient_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ContentItem` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(191) NOT NULL,
    `format` VARCHAR(191) NOT NULL DEFAULT 'post',
    `body` TEXT NOT NULL,
    `mediaUrl` VARCHAR(1000) NULL,
    `productIds` JSON NULL,
    `plannedFor` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
    `campaignId` VARCHAR(191) NULL,
    `approvalId` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `publishedBy` VARCHAR(191) NULL,
    `publishedNote` VARCHAR(500) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ContentItem_organizationId_plannedFor_idx`(`organizationId`, `plannedFor`),
    INDEX `ContentItem_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `ContentItem_campaignId_fkey`(`campaignId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `ContentItem_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ContentItem_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `MarketingCampaign`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
