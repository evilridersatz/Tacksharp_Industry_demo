-- Unified team inbox (additive only: new nullable / defaulted columns and two new tables; nothing is dropped,
-- renamed or rewritten; existing conversations become "open", normal priority, unassigned, AI on).
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `inboxStatus` VARCHAR(191) NOT NULL DEFAULT 'open';
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `priority` VARCHAR(191) NOT NULL DEFAULT 'normal';
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `assigneeId` VARCHAR(191) NULL;
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `labels` JSON NULL;
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `aiEnabled` BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `handoffReason` VARCHAR(300) NULL;
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `handoffAt` DATETIME(3) NULL;
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `lastCustomerAt` DATETIME(3) NULL;
CREATE INDEX IF NOT EXISTS `Conversation_organizationId_inboxStatus_updatedAt_idx` ON `Conversation`(`organizationId`, `inboxStatus`, `updatedAt`);
CREATE INDEX IF NOT EXISTS `Conversation_organizationId_assigneeId_inboxStatus_idx` ON `Conversation`(`organizationId`, `assigneeId`, `inboxStatus`);

CREATE TABLE IF NOT EXISTS `ConversationNote` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `conversationId` VARCHAR(191) NOT NULL,
  `authorId` VARCHAR(191) NOT NULL,
  `authorName` VARCHAR(120) NULL,
  `body` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `ConversationNote_organizationId_conversationId_createdAt_idx`(`organizationId`, `conversationId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `ConversationNote_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `SavedReply` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(120) NOT NULL,
  `body` TEXT NOT NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `SavedReply_organizationId_title_key`(`organizationId`, `title`),
  INDEX `SavedReply_organizationId_idx`(`organizationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
