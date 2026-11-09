-- AI Office (additive only): new tables, no change to existing tables or data.

CREATE TABLE `OfficeDepartment` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `key` VARCHAR(40) NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `sort` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `OfficeDepartment_organizationId_key_key`(`organizationId`, `key`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeAgent` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `departmentId` VARCHAR(191) NULL,
  `role` VARCHAR(30) NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'idle',
  `paused` BOOLEAN NOT NULL DEFAULT false,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `breaker` VARCHAR(20) NOT NULL DEFAULT 'healthy',
  `currentTaskId` VARCHAR(191) NULL,
  `activeVersion` INTEGER NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `OfficeAgent_organizationId_role_key`(`organizationId`, `role`),
  INDEX `OfficeAgent_organizationId_status_idx`(`organizationId`, `status`),
  INDEX `OfficeAgent_departmentId_idx`(`departmentId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeAgentConfiguration` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `agentId` VARCHAR(191) NOT NULL,
  `version` INTEGER NOT NULL,
  `model` VARCHAR(60) NOT NULL,
  `instructions` TEXT NULL,
  `canMessage` JSON NOT NULL,
  `budgets` JSON NOT NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `note` VARCHAR(300) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `OfficeAgentConfiguration_agentId_version_key`(`agentId`, `version`),
  INDEX `OfficeAgentConfiguration_organizationId_idx`(`organizationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeToolPermission` (
  `id` VARCHAR(191) NOT NULL,
  `agentConfigId` VARCHAR(191) NOT NULL,
  `tool` VARCHAR(60) NOT NULL,
  `mode` VARCHAR(20) NOT NULL,
  `limits` JSON NULL,
  UNIQUE INDEX `OfficeToolPermission_agentConfigId_tool_key`(`agentConfigId`, `tool`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficePlan` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `instruction` TEXT NOT NULL,
  `mode` VARCHAR(20) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
  `summary` TEXT NULL,
  `plan` JSON NOT NULL,
  `estimate` JSON NOT NULL,
  `budgets` JSON NOT NULL,
  `tokensIn` INTEGER NOT NULL DEFAULT 0,
  `tokensOut` INTEGER NOT NULL DEFAULT 0,
  `costUsd` DECIMAL(12, 6) NOT NULL DEFAULT 0,
  `steps` INTEGER NOT NULL DEFAULT 0,
  `toolCalls` INTEGER NOT NULL DEFAULT 0,
  `report` TEXT NULL,
  `reportData` JSON NULL,
  `idempotencyKey` VARCHAR(191) NOT NULL,
  `source` VARCHAR(20) NOT NULL DEFAULT 'owner',
  `workflowRunId` VARCHAR(191) NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `approvedBy` VARCHAR(191) NULL,
  `deadline` DATETIME(3) NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `OfficePlan_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
  INDEX `OfficePlan_organizationId_status_createdAt_idx`(`organizationId`, `status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeTask` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `planId` VARCHAR(191) NULL,
  `agentId` VARCHAR(191) NOT NULL,
  `role` VARCHAR(30) NOT NULL,
  `key` VARCHAR(40) NOT NULL,
  `title` VARCHAR(300) NOT NULL,
  `instructions` TEXT NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'blocked',
  `priority` INTEGER NOT NULL DEFAULT 5,
  `idempotencyKey` VARCHAR(191) NOT NULL,
  `parentTaskId` VARCHAR(191) NULL,
  `depth` INTEGER NOT NULL DEFAULT 0,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `maxAttempts` INTEGER NOT NULL DEFAULT 2,
  `reviews` INTEGER NOT NULL DEFAULT 0,
  `runAfter` DATETIME(3) NULL,
  `leaseUntil` DATETIME(3) NULL,
  `deadline` DATETIME(3) NULL,
  `tools` JSON NOT NULL,
  `context` JSON NULL,
  `result` JSON NULL,
  `verification` JSON NULL,
  `error` TEXT NULL,
  `verifiedAt` DATETIME(3) NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `OfficeTask_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
  INDEX `OfficeTask_organizationId_status_priority_idx`(`organizationId`, `status`, `priority`),
  INDEX `OfficeTask_planId_idx`(`planId`),
  INDEX `OfficeTask_status_leaseUntil_idx`(`status`, `leaseUntil`),
  INDEX `OfficeTask_agentId_idx`(`agentId`),
  INDEX `OfficeTask_parentTaskId_idx`(`parentTaskId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeTaskDependency` (
  `id` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `dependsOnId` VARCHAR(191) NOT NULL,
  UNIQUE INDEX `OfficeTaskDependency_taskId_dependsOnId_key`(`taskId`, `dependsOnId`),
  INDEX `OfficeTaskDependency_dependsOnId_idx`(`dependsOnId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeExecution` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `attempt` INTEGER NOT NULL,
  `model` VARCHAR(60) NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'running',
  `steps` INTEGER NOT NULL DEFAULT 0,
  `toolCalls` INTEGER NOT NULL DEFAULT 0,
  `tokensIn` INTEGER NOT NULL DEFAULT 0,
  `tokensOut` INTEGER NOT NULL DEFAULT 0,
  `costUsd` DECIMAL(12, 6) NOT NULL DEFAULT 0,
  `errorClass` VARCHAR(40) NULL,
  `error` TEXT NULL,
  `trace` JSON NULL,
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finishedAt` DATETIME(3) NULL,
  INDEX `OfficeExecution_taskId_attempt_idx`(`taskId`, `attempt`),
  INDEX `OfficeExecution_organizationId_startedAt_idx`(`organizationId`, `startedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeToolCall` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `agentRole` VARCHAR(30) NOT NULL,
  `tool` VARCHAR(60) NOT NULL,
  `idempotencyKey` VARCHAR(64) NOT NULL,
  `args` JSON NOT NULL,
  `status` VARCHAR(20) NOT NULL,
  `result` JSON NULL,
  `evidence` JSON NULL,
  `ms` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `OfficeToolCall_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
  INDEX `OfficeToolCall_taskId_createdAt_idx`(`taskId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeMessage` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `correlationId` VARCHAR(191) NOT NULL,
  `inReplyTo` VARCHAR(191) NULL,
  `taskId` VARCHAR(191) NULL,
  `fromRole` VARCHAR(30) NOT NULL,
  `toRole` VARCHAR(30) NOT NULL,
  `act` VARCHAR(20) NOT NULL,
  `body` TEXT NOT NULL,
  `hops` INTEGER NOT NULL DEFAULT 0,
  `deliveredAt` DATETIME(3) NULL,
  `readAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `OfficeMessage_organizationId_toRole_deliveredAt_idx`(`organizationId`, `toRole`, `deliveredAt`),
  INDEX `OfficeMessage_organizationId_correlationId_idx`(`organizationId`, `correlationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeMemory` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `scope` VARCHAR(20) NOT NULL,
  `scopeKey` VARCHAR(40) NULL,
  `text` TEXT NOT NULL,
  `source` VARCHAR(300) NOT NULL,
  `author` VARCHAR(191) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'proposed',
  `version` INTEGER NOT NULL DEFAULT 1,
  `pinned` BOOLEAN NOT NULL DEFAULT false,
  `expiresAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `OfficeMemory_organizationId_scope_status_idx`(`organizationId`, `scope`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeWorkflow` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `triggerType` VARCHAR(20) NOT NULL,
  `trigger` VARCHAR(80) NOT NULL,
  `instruction` TEXT NOT NULL,
  `mode` VARCHAR(20) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `lastRunAt` DATETIME(3) NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `OfficeWorkflow_organizationId_triggerType_enabled_idx`(`organizationId`, `triggerType`, `enabled`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeWorkflowRun` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `workflowId` VARCHAR(191) NOT NULL,
  `triggerKey` VARCHAR(191) NOT NULL,
  `planId` VARCHAR(191) NULL,
  `status` VARCHAR(20) NOT NULL,
  `note` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `OfficeWorkflowRun_workflowId_triggerKey_key`(`workflowId`, `triggerKey`),
  INDEX `OfficeWorkflowRun_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeAuditLog` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `actor` VARCHAR(191) NOT NULL,
  `action` VARCHAR(80) NOT NULL,
  `target` VARCHAR(191) NULL,
  `data` JSON NULL,
  `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `OfficeAuditLog_organizationId_at_idx`(`organizationId`, `at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeUsageRecord` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `planId` VARCHAR(191) NULL,
  `taskId` VARCHAR(191) NULL,
  `agentRole` VARCHAR(30) NOT NULL,
  `model` VARCHAR(60) NOT NULL,
  `tokensIn` INTEGER NOT NULL,
  `tokensOut` INTEGER NOT NULL,
  `cachedIn` INTEGER NOT NULL DEFAULT 0,
  `costUsd` DECIMAL(12, 6) NOT NULL,
  `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `OfficeUsageRecord_organizationId_at_idx`(`organizationId`, `at`),
  INDEX `OfficeUsageRecord_organizationId_agentRole_at_idx`(`organizationId`, `agentRole`, `at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OfficeEvent` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `type` VARCHAR(60) NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `key` VARCHAR(191) NOT NULL,
  `payload` JSON NOT NULL,
  `consumedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `OfficeEvent_organizationId_key_key`(`organizationId`, `key`),
  INDEX `OfficeEvent_consumedAt_createdAt_idx`(`consumedAt`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys
ALTER TABLE `OfficeDepartment` ADD CONSTRAINT `OfficeDepartment_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeAgent` ADD CONSTRAINT `OfficeAgent_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeAgent` ADD CONSTRAINT `OfficeAgent_departmentId_fkey` FOREIGN KEY (`departmentId`) REFERENCES `OfficeDepartment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `OfficeAgentConfiguration` ADD CONSTRAINT `OfficeAgentConfiguration_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeAgentConfiguration` ADD CONSTRAINT `OfficeAgentConfiguration_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `OfficeAgent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeToolPermission` ADD CONSTRAINT `OfficeToolPermission_agentConfigId_fkey` FOREIGN KEY (`agentConfigId`) REFERENCES `OfficeAgentConfiguration`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficePlan` ADD CONSTRAINT `OfficePlan_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeTask` ADD CONSTRAINT `OfficeTask_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeTask` ADD CONSTRAINT `OfficeTask_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `OfficePlan`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeTask` ADD CONSTRAINT `OfficeTask_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `OfficeAgent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeTask` ADD CONSTRAINT `OfficeTask_parentTaskId_fkey` FOREIGN KEY (`parentTaskId`) REFERENCES `OfficeTask`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `OfficeTaskDependency` ADD CONSTRAINT `OfficeTaskDependency_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `OfficeTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeTaskDependency` ADD CONSTRAINT `OfficeTaskDependency_dependsOnId_fkey` FOREIGN KEY (`dependsOnId`) REFERENCES `OfficeTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeExecution` ADD CONSTRAINT `OfficeExecution_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeExecution` ADD CONSTRAINT `OfficeExecution_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `OfficeTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeToolCall` ADD CONSTRAINT `OfficeToolCall_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeMessage` ADD CONSTRAINT `OfficeMessage_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeMemory` ADD CONSTRAINT `OfficeMemory_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeWorkflow` ADD CONSTRAINT `OfficeWorkflow_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeWorkflowRun` ADD CONSTRAINT `OfficeWorkflowRun_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeWorkflowRun` ADD CONSTRAINT `OfficeWorkflowRun_workflowId_fkey` FOREIGN KEY (`workflowId`) REFERENCES `OfficeWorkflow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeAuditLog` ADD CONSTRAINT `OfficeAuditLog_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeUsageRecord` ADD CONSTRAINT `OfficeUsageRecord_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OfficeEvent` ADD CONSTRAINT `OfficeEvent_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
