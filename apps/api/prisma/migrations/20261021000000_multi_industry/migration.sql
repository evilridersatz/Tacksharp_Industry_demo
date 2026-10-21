-- Multi-industry platform: demo-workspace flag, workspace memberships (explicit industry / workspace switching),
-- and manufacturing quality inspections.
-- ADDITIVE ONLY: one nullable-default column (Organization.isDemo, default false) and two new tables. No existing row
-- changes meaning (every existing organization stays isDemo = false). Idempotent (IF NOT EXISTS).
-- Back up first:  mysqldump tacksharp > backup.sql   then:  npx prisma migrate deploy

ALTER TABLE `Organization` ADD COLUMN IF NOT EXISTS `isDemo` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS `OrganizationMembership` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'admin',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OrganizationMembership_userId_organizationId_key`(`userId`, `organizationId`),
    INDEX `OrganizationMembership_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `OrganizationMembership_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `OrganizationMembership_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `QualityInspection` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `batchCode` VARCHAR(191) NOT NULL,
    `productName` VARCHAR(191) NOT NULL,
    `line` VARCHAR(191) NULL,
    `inspector` VARCHAR(191) NULL,
    `inspectedAt` DATETIME(3) NOT NULL,
    `inspectedQty` INTEGER NOT NULL,
    `rejectedQty` INTEGER NOT NULL DEFAULT 0,
    `defects` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `severity` VARCHAR(191) NOT NULL DEFAULT 'minor',
    `notes` TEXT NULL,
    `resolution` TEXT NULL,
    `resolvedAt` DATETIME(3) NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `QualityInspection_organizationId_batchCode_key`(`organizationId`, `batchCode`),
    INDEX `QualityInspection_organizationId_inspectedAt_idx`(`organizationId`, `inspectedAt`),
    INDEX `QualityInspection_organizationId_status_idx`(`organizationId`, `status`),
    PRIMARY KEY (`id`),
    CONSTRAINT `QualityInspection_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
