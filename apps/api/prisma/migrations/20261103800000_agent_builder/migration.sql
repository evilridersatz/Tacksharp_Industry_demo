-- Advanced agent builder (additive only): published versions, saved test cases, optional "tests must pass to publish".
ALTER TABLE `VoiceAgent` ADD COLUMN IF NOT EXISTS `requireTestsToPublish` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS `AgentVersion` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `agentId` VARCHAR(191) NOT NULL,
  `version` INTEGER NOT NULL,
  `snapshot` JSON NOT NULL,
  `note` VARCHAR(300) NULL,
  `publishedBy` VARCHAR(191) NULL,
  `testSummary` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `AgentVersion_agentId_version_key`(`agentId`, `version`),
  INDEX `AgentVersion_organizationId_idx`(`organizationId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AgentVersion_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `VoiceAgent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `AgentTestCase` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `agentId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `lang` VARCHAR(10) NULL,
  `turns` JSON NOT NULL,
  `lastResult` JSON NULL,
  `lastRunAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `AgentTestCase_agentId_name_key`(`agentId`, `name`),
  INDEX `AgentTestCase_organizationId_idx`(`organizationId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AgentTestCase_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `VoiceAgent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
