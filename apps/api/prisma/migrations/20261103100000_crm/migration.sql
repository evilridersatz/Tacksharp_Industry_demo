-- CRM (additive only): custom attributes, stage, follow-up date on Customer; CustomerNote table. Nothing dropped or
-- rewritten; existing customers have no stage ("new"), no attributes, no follow-up date.
ALTER TABLE `Customer` ADD COLUMN IF NOT EXISTS `attributes` JSON NULL;
ALTER TABLE `Customer` ADD COLUMN IF NOT EXISTS `stage` VARCHAR(191) NULL;
ALTER TABLE `Customer` ADD COLUMN IF NOT EXISTS `followUpAt` DATETIME(3) NULL;
CREATE INDEX IF NOT EXISTS `Customer_organizationId_stage_idx` ON `Customer`(`organizationId`, `stage`);
CREATE INDEX IF NOT EXISTS `Customer_organizationId_followUpAt_idx` ON `Customer`(`organizationId`, `followUpAt`);

CREATE TABLE IF NOT EXISTS `CustomerNote` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `authorId` VARCHAR(191) NOT NULL,
  `authorName` VARCHAR(120) NULL,
  `body` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `CustomerNote_organizationId_customerId_createdAt_idx`(`organizationId`, `customerId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `CustomerNote_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
