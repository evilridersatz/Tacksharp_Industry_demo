-- Organization resolution for inbound webhooks (WhatsApp phone_number_id, Plivo number, Meta page id).
-- Idempotent on purpose: it is safe whether or not the 0_baseline migration (generated from the current
-- schema.prisma) already created this table.
CREATE TABLE IF NOT EXISTS `OrganizationChannel` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `externalId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OrganizationChannel_kind_externalId_key`(`kind`, `externalId`),
    INDEX `OrganizationChannel_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `OrganizationChannel_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
