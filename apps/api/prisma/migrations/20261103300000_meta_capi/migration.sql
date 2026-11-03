-- Meta Conversions API outbox (additive only): one new table. No customer data is stored here unhashed or at all:
-- hashes are computed at send time from the Customer row.
CREATE TABLE IF NOT EXISTS `MetaCapiEvent` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `eventId` VARCHAR(191) NOT NULL,
  `eventName` VARCHAR(40) NOT NULL,
  `sourceType` VARCHAR(30) NOT NULL,
  `sourceId` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `eventTime` DATETIME(3) NOT NULL,
  `actionSource` VARCHAR(30) NOT NULL,
  `value` DECIMAL(14, 2) NULL,
  `currency` VARCHAR(3) NULL,
  `orderRef` VARCHAR(191) NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'queued',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `nextAttemptAt` DATETIME(3) NULL,
  `lastError` VARCHAR(500) NULL,
  `fbtraceId` VARCHAR(191) NULL,
  `testEvent` BOOLEAN NOT NULL DEFAULT false,
  `sentAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `MetaCapiEvent_organizationId_eventId_key`(`organizationId`, `eventId`),
  INDEX `MetaCapiEvent_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
  INDEX `MetaCapiEvent_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
