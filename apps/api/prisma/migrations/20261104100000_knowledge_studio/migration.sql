-- Knowledge studio (additive only): answers written in the dashboard are ordinary text documents marked `authored`;
-- questions an agent could not answer from its knowledge base are kept as gaps for the team to fill.
ALTER TABLE `KnowledgeDocument` ADD COLUMN `authored` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `KnowledgeGap` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `knowledgeBaseId` VARCHAR(191) NOT NULL,
  `agentId` VARCHAR(191) NULL,
  `questionKey` VARCHAR(191) NOT NULL,
  `question` TEXT NOT NULL,
  `channel` VARCHAR(191) NOT NULL,
  `count` INTEGER NOT NULL DEFAULT 1,
  `status` VARCHAR(191) NOT NULL DEFAULT 'open',
  `documentId` VARCHAR(191) NULL,
  `resolvedBy` VARCHAR(191) NULL,
  `resolvedAt` DATETIME(3) NULL,
  `firstAskedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastAskedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `KnowledgeGap_knowledgeBaseId_questionKey_key`(`knowledgeBaseId`, `questionKey`),
  INDEX `KnowledgeGap_organizationId_status_lastAskedAt_idx`(`organizationId`, `status`, `lastAskedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `KnowledgeGap_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `KnowledgeGap_knowledgeBaseId_fkey` FOREIGN KEY (`knowledgeBaseId`) REFERENCES `KnowledgeBase`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
