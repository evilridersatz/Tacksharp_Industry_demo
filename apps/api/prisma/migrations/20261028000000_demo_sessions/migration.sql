-- Shared-number live demos: binds an approved test phone to one industry workspace for a limited time.
-- ADDITIVE ONLY: one new table, no existing table or column changes. Idempotent (IF NOT EXISTS).
-- Back up first:  mysqldump <db> > backup.sql   then:  npx prisma migrate deploy

CREATE TABLE IF NOT EXISTS `DemoSession` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `industry` VARCHAR(191) NOT NULL,
    `hubOrganizationId` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `channels` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `endedReason` VARCHAR(191) NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `lastActivityAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,
    INDEX `DemoSession_phone_status_idx`(`phone`, `status`),
    INDEX `DemoSession_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `DemoSession_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
