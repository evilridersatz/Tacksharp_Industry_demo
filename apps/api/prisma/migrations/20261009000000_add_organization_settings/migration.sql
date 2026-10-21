-- Per-business automation settings (cadence, visit reminders, team alerts, ROI inputs).
-- Idempotent on purpose: safe whether or not the 0_baseline migration already created this table.
CREATE TABLE IF NOT EXISTS `OrganizationSettings` (
    `organizationId` VARCHAR(191) NOT NULL,
    `data` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`organizationId`),
    CONSTRAINT `OrganizationSettings_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
