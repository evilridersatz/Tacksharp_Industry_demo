CREATE TABLE `Conversation` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NULL,
    `channel` VARCHAR(191) NOT NULL,
    `externalId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Conversation_organizationId_idx`(`organizationId`),
    INDEX `Conversation_organizationId_customerId_idx`(`organizationId`, `customerId`),
    INDEX `Conversation_organizationId_channel_idx`(`organizationId`, `channel`),
    UNIQUE INDEX `Conversation_organizationId_channel_externalId_key`(`organizationId`, `channel`, `externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Message` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `externalId` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Message_organizationId_idx`(`organizationId`),
    INDEX `Message_organizationId_conversationId_idx`(`organizationId`, `conversationId`),
    INDEX `Message_conversationId_createdAt_idx`(`conversationId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Conversation`
ADD CONSTRAINT `Conversation_organizationId_fkey`
FOREIGN KEY (`organizationId`)
REFERENCES `Organization`(`id`)
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE `Conversation`
ADD CONSTRAINT `Conversation_customerId_fkey`
FOREIGN KEY (`customerId`)
REFERENCES `Customer`(`id`)
ON DELETE SET NULL
ON UPDATE CASCADE;

ALTER TABLE `Message`
ADD CONSTRAINT `Message_organizationId_fkey`
FOREIGN KEY (`organizationId`)
REFERENCES `Organization`(`id`)
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE `Message`
ADD CONSTRAINT `Message_conversationId_fkey`
FOREIGN KEY (`conversationId`)
REFERENCES `Conversation`(`id`)
ON DELETE CASCADE
ON UPDATE CASCADE;