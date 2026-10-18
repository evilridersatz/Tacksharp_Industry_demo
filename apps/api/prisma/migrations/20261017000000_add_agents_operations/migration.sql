-- AI agents (Orchestrator + Marketing / Sales / Finance / Operations) and textile operations (inventory).
-- NEW TABLES ONLY: AgentTask, AgentTaskEvent, Approval, WorkTask, InventoryBalance, StockMovement.
-- No existing table, column or row is changed. Idempotent (CREATE TABLE IF NOT EXISTS).
-- Requires the textile migration (20261016000000_add_textile_sales) first: InventoryBalance / StockMovement
-- reference TextileProduct.
-- Back up the database before applying:  mysqldump tacksharp > backup.sql   then:  npx prisma migrate deploy

CREATE TABLE IF NOT EXISTS `AgentTask` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `agent` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `trigger` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NULL,
    `entityId` VARCHAR(191) NULL,
    `input` JSON NULL,
    `result` JSON NULL,
    `error` TEXT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `timeoutMs` INTEGER NOT NULL DEFAULT 30000,
    `parentTaskId` VARCHAR(191) NULL,
    `depth` INTEGER NOT NULL DEFAULT 0,
    `approvalId` VARCHAR(191) NULL,
    `requestedBy` VARCHAR(191) NOT NULL,
    `runAfter` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AgentTask_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    INDEX `AgentTask_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `AgentTask_organizationId_agent_createdAt_idx`(`organizationId`, `agent`, `createdAt`),
    INDEX `AgentTask_organizationId_entityType_entityId_idx`(`organizationId`, `entityType`, `entityId`),
    INDEX `AgentTask_parentTaskId_fkey`(`parentTaskId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `AgentTask_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `AgentTask_parentTaskId_fkey` FOREIGN KEY (`parentTaskId`) REFERENCES `AgentTask`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `AgentTaskEvent` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `message` VARCHAR(500) NOT NULL,
    `data` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AgentTaskEvent_taskId_createdAt_idx`(`taskId`, `createdAt`),
    INDEX `AgentTaskEvent_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `AgentTaskEvent_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `AgentTaskEvent_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `AgentTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Approval` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `requestedBy` VARCHAR(191) NOT NULL,
    `reason` TEXT NOT NULL,
    `payload` JSON NOT NULL,
    `payloadHash` VARCHAR(64) NOT NULL,
    `requiredPermission` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `openKey` VARCHAR(191) NULL,
    `decidedBy` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` TEXT NULL,
    `expiresAt` DATETIME(3) NULL,
    `executedAt` DATETIME(3) NULL,
    `executionResult` JSON NULL,
    `taskId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Approval_openKey_key`(`openKey`),
    INDEX `Approval_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `Approval_organizationId_entityType_entityId_idx`(`organizationId`, `entityType`, `entityId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `Approval_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `WorkTask` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `agent` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `title` VARCHAR(300) NOT NULL,
    `detail` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `priority` VARCHAR(191) NOT NULL DEFAULT 'normal',
    `assignee` VARCHAR(191) NULL,
    `dueAt` DATETIME(3) NULL,
    `entityType` VARCHAR(191) NULL,
    `entityId` VARCHAR(191) NULL,
    `dedupeKey` VARCHAR(191) NULL,
    `resolution` TEXT NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WorkTask_dedupeKey_key`(`dedupeKey`),
    INDEX `WorkTask_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `WorkTask_organizationId_agent_status_idx`(`organizationId`, `agent`, `status`),
    INDEX `WorkTask_organizationId_entityType_entityId_idx`(`organizationId`, `entityType`, `entityId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `WorkTask_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `InventoryBalance` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `location` VARCHAR(191) NOT NULL DEFAULT 'main',
    `onHand` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `reserved` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `lowStockAt` DECIMAL(14, 2) NULL,
    `allowNegative` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `InventoryBalance_productId_location_key`(`productId`, `location`),
    INDEX `InventoryBalance_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `InventoryBalance_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `InventoryBalance_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `TextileProduct`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `StockMovement` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `location` VARCHAR(191) NOT NULL DEFAULT 'main',
    `type` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(14, 2) NOT NULL,
    `onHandAfter` DECIMAL(14, 2) NOT NULL,
    `reservedAfter` DECIMAL(14, 2) NOT NULL,
    `orderId` VARCHAR(191) NULL,
    `lot` VARCHAR(191) NULL,
    `reference` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `StockMovement_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    INDEX `StockMovement_organizationId_productId_createdAt_idx`(`organizationId`, `productId`, `createdAt`),
    INDEX `StockMovement_organizationId_orderId_idx`(`organizationId`, `orderId`),
    INDEX `StockMovement_productId_fkey`(`productId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `StockMovement_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `StockMovement_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `TextileProduct`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
