-- GR Chicken follow-ups: consent + demo flags on customers, feedback / complaint / follow-up state on
-- orders, and the OrderFollowUp table. Additive only: no existing column or row is changed.

-- AlterTable
ALTER TABLE `Customer` ADD COLUMN `messagingConsent` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `callingConsent` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `optedOutAt` DATETIME(3) NULL,
    ADD COLUMN `isDemo` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Order` ADD COLUMN `collectedAt` DATETIME(3) NULL,
    ADD COLUMN `feedbackRating` INTEGER NULL,
    ADD COLUMN `feedbackComment` TEXT NULL,
    ADD COLUMN `feedbackAt` DATETIME(3) NULL,
    ADD COLUMN `feedbackChannel` VARCHAR(191) NULL,
    ADD COLUMN `complaintStatus` VARCHAR(191) NULL,
    ADD COLUMN `complaintNote` TEXT NULL,
    ADD COLUMN `followUpStatus` VARCHAR(191) NULL,
    ADD COLUMN `lastContactAt` DATETIME(3) NULL,
    ADD COLUMN `nextFollowUpAt` DATETIME(3) NULL,
    ADD COLUMN `demoScenario` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `OrderFollowUp` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'scheduled',
    `scheduledAt` DATETIME(3) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `dryRun` BOOLEAN NOT NULL DEFAULT true,
    `payload` JSON NULL,
    `result` JSON NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `callId` VARCHAR(191) NULL,
    `lastError` TEXT NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`),
    INDEX `OrderFollowUp_organizationId_status_scheduledAt_idx`(`organizationId`, `status`, `scheduledAt`),
    INDEX `OrderFollowUp_orderId_idx`(`orderId`),
    INDEX `OrderFollowUp_customerId_idx`(`customerId`),
    INDEX `OrderFollowUp_providerMessageId_idx`(`providerMessageId`),
    UNIQUE INDEX `OrderFollowUp_organizationId_dedupeKey_key`(`organizationId`, `dedupeKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OrderFollowUp` ADD CONSTRAINT `OrderFollowUp_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderFollowUp` ADD CONSTRAINT `OrderFollowUp_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderFollowUp` ADD CONSTRAINT `OrderFollowUp_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
