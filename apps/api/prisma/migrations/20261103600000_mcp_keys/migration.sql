-- MCP server (additive only): access keys for AI assistants. Only a SHA-256 hash of each key is stored.
CREATE TABLE IF NOT EXISTS `McpAccessKey` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `prefix` VARCHAR(20) NOT NULL,
  `keyHash` VARCHAR(64) NOT NULL,
  `scope` VARCHAR(20) NOT NULL DEFAULT 'read',
  `createdBy` VARCHAR(191) NULL,
  `lastUsedAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `McpAccessKey_keyHash_key`(`keyHash`),
  INDEX `McpAccessKey_organizationId_idx`(`organizationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
