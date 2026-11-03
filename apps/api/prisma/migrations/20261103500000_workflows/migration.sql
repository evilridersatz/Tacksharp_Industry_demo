-- Visual Workflow Studio (additive only): two new tables. Nothing existing is altered.
CREATE TABLE IF NOT EXISTS `Workflow` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `description` VARCHAR(500) NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
  `graph` JSON NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `activatedAt` DATETIME(3) NULL,
  `createdBy` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `Workflow_organizationId_name_key`(`organizationId`, `name`),
  INDEX `Workflow_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `WorkflowRun` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `workflowId` VARCHAR(191) NOT NULL,
  `version` INTEGER NOT NULL,
  `graph` JSON NOT NULL,
  `triggerKey` VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NULL,
  `context` JSON NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'running',
  `cursor` JSON NULL,
  `resumeAt` DATETIME(3) NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `log` JSON NULL,
  `test` BOOLEAN NOT NULL DEFAULT false,
  `lastError` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `completedAt` DATETIME(3) NULL,
  UNIQUE INDEX `WorkflowRun_workflowId_triggerKey_key`(`workflowId`, `triggerKey`),
  INDEX `WorkflowRun_status_resumeAt_idx`(`status`, `resumeAt`),
  INDEX `WorkflowRun_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `WorkflowRun_workflowId_fkey` FOREIGN KEY (`workflowId`) REFERENCES `Workflow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
