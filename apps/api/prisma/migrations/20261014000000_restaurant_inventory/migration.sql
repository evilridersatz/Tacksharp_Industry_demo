-- GR Chicken inventory: stock on hand per product + a movement ledger. Additive only: no existing column or row
-- is changed or removed (existing products keep stockQty = NULL, i.e. stock not tracked, until staff set it).

-- AlterTable
ALTER TABLE `MenuItem` ADD COLUMN `stockQty` DECIMAL(10, 3) NULL,
    ADD COLUMN `lowStockThreshold` DECIMAL(10, 3) NULL,
    ADD COLUMN `stockIsDemo` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `stockUpdatedAt` DATETIME(3) NULL,
    ADD COLUMN `stockAlertLevel` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `InventoryMovement` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `menuItemId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NULL,
    `delta` DECIMAL(10, 3) NOT NULL,
    `balanceAfter` DECIMAL(10, 3) NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `actor` VARCHAR(191) NULL,
    `dedupeKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    INDEX `InventoryMovement_organizationId_menuItemId_createdAt_idx`(`organizationId`, `menuItemId`, `createdAt`),
    INDEX `InventoryMovement_orderId_idx`(`orderId`),
    UNIQUE INDEX `InventoryMovement_organizationId_dedupeKey_key`(`organizationId`, `dedupeKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `InventoryMovement` ADD CONSTRAINT `InventoryMovement_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InventoryMovement` ADD CONSTRAINT `InventoryMovement_menuItemId_fkey` FOREIGN KEY (`menuItemId`) REFERENCES `MenuItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
