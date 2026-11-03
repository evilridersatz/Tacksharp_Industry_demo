-- Drip automation (additive only): three new tables. Nothing existing is altered, dropped or rewritten.
CREATE TABLE IF NOT EXISTS `DripSequence` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `description` VARCHAR(500) NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
  `steps` JSON NOT NULL,
  `stopOnReply` BOOLEAN NOT NULL DEFAULT true,
  `sendStartHour` INTEGER NOT NULL DEFAULT 9,
  `sendEndHour` INTEGER NOT NULL DEFAULT 20,
  `createdBy` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `DripSequence_organizationId_name_key`(`organizationId`, `name`),
  INDEX `DripSequence_organizationId_status_idx`(`organizationId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `DripEnrollment` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `sequenceId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `stepIndex` INTEGER NOT NULL DEFAULT 0,
  `nextRunAt` DATETIME(3) NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `stopReason` VARCHAR(191) NULL,
  `lastError` VARCHAR(500) NULL,
  `enrolledBy` VARCHAR(191) NULL,
  `enrolledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `DripEnrollment_sequenceId_customerId_key`(`sequenceId`, `customerId`),
  INDEX `DripEnrollment_status_nextRunAt_idx`(`status`, `nextRunAt`),
  INDEX `DripEnrollment_organizationId_customerId_idx`(`organizationId`, `customerId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `DripEnrollment_sequenceId_fkey` FOREIGN KEY (`sequenceId`) REFERENCES `DripSequence`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `DripEnrollment_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `DripStepRun` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `enrollmentId` VARCHAR(191) NOT NULL,
  `stepIndex` INTEGER NOT NULL,
  `channel` VARCHAR(20) NOT NULL,
  `status` VARCHAR(20) NOT NULL,
  `reason` VARCHAR(500) NULL,
  `providerMessageId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `DripStepRun_enrollmentId_stepIndex_key`(`enrollmentId`, `stepIndex`),
  INDEX `DripStepRun_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `DripStepRun_enrollmentId_fkey` FOREIGN KEY (`enrollmentId`) REFERENCES `DripEnrollment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
