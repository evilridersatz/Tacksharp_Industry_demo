-- Enterprise subscriptions (additive only): billing contracts, one subscription per organization, Tacksharp's own
-- invoices to the organization (PlatformInvoice; not the finance module's customer invoices).
-- Organizations without a subscription keep working exactly as before (no plan limits are enforced for them).
CREATE TABLE IF NOT EXISTS `BillingContract` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `billingEmail` VARCHAR(191) NULL,
  `billingAddress` VARCHAR(500) NULL,
  `gstin` VARCHAR(20) NULL,
  `notes` VARCHAR(1000) NULL,
  `createdBy` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Subscription` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `planCode` VARCHAR(20) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `billingCycle` VARCHAR(20) NOT NULL DEFAULT 'monthly',
  `price` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `taxRatePct` DECIMAL(5, 2) NOT NULL DEFAULT 18,
  `limitsOverride` JSON NULL,
  `trialEndsAt` DATETIME(3) NULL,
  `currentPeriodStart` DATETIME(3) NOT NULL,
  `currentPeriodEnd` DATETIME(3) NOT NULL,
  `autoRenew` BOOLEAN NOT NULL DEFAULT true,
  `contractId` VARCHAR(191) NULL,
  `notes` VARCHAR(1000) NULL,
  `createdBy` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `Subscription_organizationId_key`(`organizationId`),
  INDEX `Subscription_status_currentPeriodEnd_idx`(`status`, `currentPeriodEnd`),
  INDEX `Subscription_contractId_idx`(`contractId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `Subscription_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `Subscription_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `BillingContract`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `PlatformInvoice` (
  `id` VARCHAR(191) NOT NULL,
  `number` VARCHAR(40) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `subscriptionId` VARCHAR(191) NULL,
  `description` VARCHAR(300) NOT NULL,
  `periodStart` DATETIME(3) NOT NULL,
  `periodEnd` DATETIME(3) NOT NULL,
  `subtotal` DECIMAL(12, 2) NOT NULL,
  `taxRatePct` DECIMAL(5, 2) NOT NULL,
  `tax` DECIMAL(12, 2) NOT NULL,
  `total` DECIMAL(12, 2) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'issued',
  `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `dueAt` DATETIME(3) NOT NULL,
  `paidAt` DATETIME(3) NULL,
  `paymentReference` VARCHAR(120) NULL,
  `voidReason` VARCHAR(300) NULL,
  `createdBy` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `PlatformInvoice_number_key`(`number`),
  UNIQUE INDEX `PlatformInvoice_subscriptionId_periodStart_key`(`subscriptionId`, `periodStart`),
  INDEX `PlatformInvoice_organizationId_issuedAt_idx`(`organizationId`, `issuedAt`),
  INDEX `PlatformInvoice_status_dueAt_idx`(`status`, `dueAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `PlatformInvoice_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
