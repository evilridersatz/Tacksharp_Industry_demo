-- Team access: expiring single-use invitation / password-reset links and immediate session revocation.
-- ADDITIVE ONLY: one new table and two NULLABLE columns on User (existing rows unaffected). Idempotent where MySQL allows.
-- Back up first:  mysqldump <db> > backup.sql   then:  npx prisma migrate deploy

ALTER TABLE `User` ADD COLUMN IF NOT EXISTS `disabledAt` DATETIME(3) NULL;
ALTER TABLE `User` ADD COLUMN IF NOT EXISTS `sessionsRevokedAt` DATETIME(3) NULL;

CREATE TABLE IF NOT EXISTS `UserInvitation` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL DEFAULT 'invite',
    `email` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `UserInvitation_tokenHash_key`(`tokenHash`),
    INDEX `UserInvitation_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `UserInvitation_email_idx`(`email`),
    PRIMARY KEY (`id`),
    CONSTRAINT `UserInvitation_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
