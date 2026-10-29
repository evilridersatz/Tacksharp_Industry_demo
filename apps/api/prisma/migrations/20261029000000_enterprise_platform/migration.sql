-- Enterprise platform: organization lifecycle (self-service signup, activation, suspension), platform superadmin flag,
-- encrypted per-organization provider credentials, provider usage / error log.
-- ADDITIVE ONLY: new NULLABLE / defaulted columns and two new tables. Existing organizations stay `active`, existing
-- users are not platform admins, GR Chicken settings and channels are untouched.
-- Back up first:  mysqldump <db> > backup.sql   then:  npx prisma migrate deploy

ALTER TABLE `Organization` ADD COLUMN IF NOT EXISTS `status` VARCHAR(191) NOT NULL DEFAULT 'active';
ALTER TABLE `Organization` ADD COLUMN IF NOT EXISTS `selfServe` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `Organization` ADD COLUMN IF NOT EXISTS `activatedAt` DATETIME(3) NULL;
ALTER TABLE `Organization` ADD COLUMN IF NOT EXISTS `suspendedAt` DATETIME(3) NULL;
ALTER TABLE `Organization` ADD COLUMN IF NOT EXISTS `suspendedReason` VARCHAR(191) NULL;
ALTER TABLE `Organization` ADD COLUMN IF NOT EXISTS `allowedIndustries` JSON NULL;
ALTER TABLE `Organization` ADD COLUMN IF NOT EXISTS `contactPhone` VARCHAR(191) NULL;

ALTER TABLE `User` ADD COLUMN IF NOT EXISTS `isPlatformAdmin` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `User` ADD COLUMN IF NOT EXISTS `emailVerifiedAt` DATETIME(3) NULL;

CREATE TABLE IF NOT EXISTS `IntegrationCredential` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `config` JSON NULL,
    `secretCiphertext` TEXT NULL,
    `secretIv` VARCHAR(191) NULL,
    `secretTag` VARCHAR(191) NULL,
    `keyVersion` VARCHAR(191) NULL,
    `secretHints` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'untested',
    `lastTestAt` DATETIME(3) NULL,
    `lastSuccessAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `updatedBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `IntegrationCredential_organizationId_provider_key`(`organizationId`, `provider`),
    PRIMARY KEY (`id`),
    CONSTRAINT `IntegrationCredential_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `IntegrationEvent` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `ok` BOOLEAN NOT NULL,
    `latencyMs` INTEGER NULL,
    `errorCode` VARCHAR(191) NULL,
    `message` TEXT NULL,
    `units` INTEGER NULL,
    `unitType` VARCHAR(191) NULL,
    `costEstimate` DECIMAL(12, 4) NULL,
    `source` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `IntegrationEvent_organizationId_provider_createdAt_idx`(`organizationId`, `provider`, `createdAt`),
    INDEX `IntegrationEvent_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `IntegrationEvent_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
