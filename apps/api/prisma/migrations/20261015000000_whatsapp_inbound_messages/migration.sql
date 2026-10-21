-- Durable, de-duplicated inbound WhatsApp messages and their reply state. Additive only.

-- CreateTable
CREATE TABLE `InboundMessage` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(191) NOT NULL DEFAULT 'whatsapp',
    `providerMessageId` VARCHAR(191) NOT NULL,
    `fromPhone` VARCHAR(191) NOT NULL,
    `messageType` VARCHAR(191) NOT NULL,
    `payload` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'received',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `conversationId` VARCHAR(191) NULL,
    `replyText` TEXT NULL,
    `replyStatus` VARCHAR(191) NULL,
    `replyProviderId` VARCHAR(191) NULL,
    `lastError` VARCHAR(500) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`),
    INDEX `InboundMessage_organizationId_status_receivedAt_idx`(`organizationId`, `status`, `receivedAt`),
    UNIQUE INDEX `InboundMessage_organizationId_providerMessageId_key`(`organizationId`, `providerMessageId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `InboundMessage` ADD CONSTRAINT `InboundMessage_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
