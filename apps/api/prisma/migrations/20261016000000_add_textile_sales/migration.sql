-- Textile sales module (industry = textile): catalogue, buyer requirement, quotations, orders, feedback, audit log.
-- NEW TABLES ONLY. No existing table, column or row is changed. Idempotent (CREATE TABLE IF NOT EXISTS).
-- Back up the database before applying:  mysqldump tacksharp > backup.sql   then:  npx prisma migrate deploy

CREATE TABLE IF NOT EXISTS `TextileProduct` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `fabricCategory` VARCHAR(191) NOT NULL,
    `composition` VARCHAR(191) NULL,
    `gsm` INTEGER NULL,
    `width` VARCHAR(191) NULL,
    `colour` VARCHAR(191) NULL,
    `design` VARCHAR(191) NULL,
    `sizes` VARCHAR(191) NULL,
    `moq` INTEGER NULL,
    `priceUnit` VARCHAR(191) NOT NULL DEFAULT 'metre',
    `currency` VARCHAR(191) NOT NULL DEFAULT 'INR',
    `price` DECIMAL(12, 2) NULL,
    `priceApproved` BOOLEAN NOT NULL DEFAULT false,
    `stockStatus` VARCHAR(191) NOT NULL DEFAULT 'unknown',
    `imageUrls` JSON NULL,
    `catalogueUrl` VARCHAR(500) NULL,
    `leadTimeDays` INTEGER NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TextileProduct_organizationId_sku_key`(`organizationId`, `sku`),
    INDEX `TextileProduct_organizationId_active_idx`(`organizationId`, `active`),
    INDEX `TextileProduct_organizationId_fabricCategory_idx`(`organizationId`, `fabricCategory`),
    PRIMARY KEY (`id`),
    CONSTRAINT `TextileProduct_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `TextileRequirement` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `buyerType` VARCHAR(191) NULL,
    `productInterest` VARCHAR(191) NULL,
    `fabricCategory` VARCHAR(191) NULL,
    `colour` VARCHAR(191) NULL,
    `quantity` DECIMAL(12, 2) NULL,
    `quantityUnit` VARCHAR(191) NULL,
    `targetPrice` DECIMAL(12, 2) NULL,
    `destination` VARCHAR(191) NULL,
    `neededBy` VARCHAR(191) NULL,
    `assignedTo` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TextileRequirement_leadId_key`(`leadId`),
    INDEX `TextileRequirement_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `TextileRequirement_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `TextileRequirement_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Quotation` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NULL,
    `number` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
    `currency` VARCHAR(191) NOT NULL DEFAULT 'INR',
    `subtotal` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `discount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `taxPercent` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `tax` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `shipping` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `total` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `validUntil` DATETIME(3) NULL,
    `paymentTerms` VARCHAR(191) NULL,
    `deliveryTerms` VARCHAR(191) NULL,
    `salesperson` VARCHAR(191) NULL,
    `origin` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `notes` TEXT NULL,
    `sentAt` DATETIME(3) NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Quotation_organizationId_number_key`(`organizationId`, `number`),
    INDEX `Quotation_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `Quotation_organizationId_customerId_idx`(`organizationId`, `customerId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `Quotation_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `Quotation_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `Quotation_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `QuotationItem` (
    `id` VARCHAR(191) NOT NULL,
    `quotationId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NULL,
    `sku` VARCHAR(191) NULL,
    `description` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(12, 2) NOT NULL,
    `unit` VARCHAR(191) NOT NULL DEFAULT 'metre',
    `unitPrice` DECIMAL(12, 2) NOT NULL,
    `lineTotal` DECIMAL(14, 2) NOT NULL,

    INDEX `QuotationItem_quotationId_idx`(`quotationId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `QuotationItem_quotationId_fkey` FOREIGN KEY (`quotationId`) REFERENCES `Quotation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `QuotationItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `TextileProduct`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `SalesOrder` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NULL,
    `quotationId` VARCHAR(191) NULL,
    `number` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending_confirmation',
    `paymentStatus` VARCHAR(191) NOT NULL DEFAULT 'unpaid',
    `currency` VARCHAR(191) NOT NULL DEFAULT 'INR',
    `total` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `expectedDelivery` DATETIME(3) NULL,
    `shippingAddress` TEXT NULL,
    `salesperson` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SalesOrder_quotationId_key`(`quotationId`),
    UNIQUE INDEX `SalesOrder_organizationId_number_key`(`organizationId`, `number`),
    INDEX `SalesOrder_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `SalesOrder_organizationId_customerId_idx`(`organizationId`, `customerId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `SalesOrder_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `SalesOrder_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `SalesOrder_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT `SalesOrder_quotationId_fkey` FOREIGN KEY (`quotationId`) REFERENCES `Quotation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `SalesOrderItem` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NULL,
    `sku` VARCHAR(191) NULL,
    `description` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(12, 2) NOT NULL,
    `unit` VARCHAR(191) NOT NULL DEFAULT 'metre',
    `unitPrice` DECIMAL(12, 2) NOT NULL,
    `lineTotal` DECIMAL(14, 2) NOT NULL,

    INDEX `SalesOrderItem_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `SalesOrderItem_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `SalesOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `SalesOrderItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `TextileProduct`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Feedback` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NULL,
    `channel` VARCHAR(191) NOT NULL DEFAULT 'whatsapp',
    `rating` INTEGER NULL,
    `comment` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'requested',
    `owner` VARCHAR(191) NULL,
    `resolution` TEXT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `receivedAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Feedback_orderId_key`(`orderId`),
    INDEX `Feedback_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `Feedback_organizationId_customerId_idx`(`organizationId`, `customerId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `Feedback_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `Feedback_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `Feedback_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `SalesOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `AuditEvent` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `data` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditEvent_organizationId_entityType_entityId_idx`(`organizationId`, `entityType`, `entityId`),
    INDEX `AuditEvent_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `AuditEvent_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
