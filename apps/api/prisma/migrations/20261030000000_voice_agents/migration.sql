-- Custom voice agents, knowledge bases, telephony provider routing (Sarvam / Plivo), idempotent outbound call requests
-- and deduplicated telephony webhooks.
-- ADDITIVE ONLY: two nullable / defaulted columns on `Call` and six new tables. Existing calls keep provider 'plivo'
-- and no agent (the built-in industry engine), so GR Chicken is unchanged.
-- Back up first:  mysqldump <db> > backup.sql   then:  npx prisma migrate deploy

ALTER TABLE `Call` ADD COLUMN IF NOT EXISTS `agentId` VARCHAR(191) NULL;
ALTER TABLE `Call` ADD COLUMN IF NOT EXISTS `provider` VARCHAR(191) NULL DEFAULT 'plivo';

CREATE TABLE IF NOT EXISTS `KnowledgeBase` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `KnowledgeBase_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `KnowledgeBase_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `VoiceAgent` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `industry` VARCHAR(191) NOT NULL,
    `useCase` VARCHAR(191) NULL,
    `templateKey` VARCHAR(191) NULL,
    `instructions` TEXT NOT NULL,
    `languages` JSON NOT NULL,
    `voice` JSON NULL,
    `inbound` JSON NULL,
    `outbound` JSON NULL,
    `greeting` TEXT NOT NULL,
    `fallbackMessage` TEXT NOT NULL,
    `knowledgeBaseId` VARCHAR(191) NULL,
    `businessHours` JSON NULL,
    `escalation` JSON NULL,
    `callLimits` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
    `telephonyProvider` VARCHAR(191) NOT NULL DEFAULT 'plivo',
    `sarvamAppId` VARCHAR(191) NULL,
    `sarvamAppVersion` INTEGER NULL,
    `lastTestedAt` DATETIME(3) NULL,
    `publishedAt` DATETIME(3) NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `VoiceAgent_organizationId_status_idx`(`organizationId`, `status`),
    PRIMARY KEY (`id`),
    CONSTRAINT `VoiceAgent_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `VoiceAgent_knowledgeBaseId_fkey` FOREIGN KEY (`knowledgeBaseId`) REFERENCES `KnowledgeBase`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `KnowledgeDocument` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `knowledgeBaseId` VARCHAR(191) NOT NULL,
    `filename` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `sha256` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'uploaded',
    `error` TEXT NULL,
    `chunkCount` INTEGER NOT NULL DEFAULT 0,
    `charCount` INTEGER NOT NULL DEFAULT 0,
    `flaggedLines` INTEGER NOT NULL DEFAULT 0,
    `storagePath` VARCHAR(191) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `processedAt` DATETIME(3) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `KnowledgeDocument_organizationId_knowledgeBaseId_idx`(`organizationId`, `knowledgeBaseId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `KnowledgeDocument_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `KnowledgeDocument_knowledgeBaseId_fkey` FOREIGN KEY (`knowledgeBaseId`) REFERENCES `KnowledgeBase`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `KnowledgeChunk` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `knowledgeBaseId` VARCHAR(191) NOT NULL,
    `documentId` VARCHAR(191) NOT NULL,
    `ord` INTEGER NOT NULL,
    `text` TEXT NOT NULL,
    `source` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `KnowledgeChunk_organizationId_knowledgeBaseId_idx`(`organizationId`, `knowledgeBaseId`),
    INDEX `KnowledgeChunk_documentId_idx`(`documentId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `KnowledgeChunk_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `KnowledgeChunk_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `TelephonyCallRequest` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NULL,
    `customerId` VARCHAR(191) NULL,
    `toNumber` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `failureReason` VARCHAR(191) NULL,
    `providerCallId` VARCHAR(191) NULL,
    `callId` VARCHAR(191) NULL,
    `requestedBy` VARCHAR(191) NULL,
    `durationSec` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `TelephonyCallRequest_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    INDEX `TelephonyCallRequest_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `TelephonyCallRequest_providerCallId_idx`(`providerCallId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `TelephonyCallRequest_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `TelephonyWebhookEvent` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `eventKey` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `TelephonyWebhookEvent_provider_eventKey_key`(`provider`, `eventKey`),
    INDEX `TelephonyWebhookEvent_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `TelephonyWebhookEvent_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
