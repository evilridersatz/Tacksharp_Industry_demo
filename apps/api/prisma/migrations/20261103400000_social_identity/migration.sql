-- Instagram / Messenger (additive only): one new table linking a Meta user id (PSID / IGSID) to a customer record.
CREATE TABLE IF NOT EXISTS `SocialIdentity` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `channel` VARCHAR(20) NOT NULL,
  `externalUserId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `displayName` VARCHAR(120) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `SocialIdentity_organizationId_channel_externalUserId_key`(`organizationId`, `channel`, `externalUserId`),
  INDEX `SocialIdentity_customerId_idx`(`customerId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `SocialIdentity_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
