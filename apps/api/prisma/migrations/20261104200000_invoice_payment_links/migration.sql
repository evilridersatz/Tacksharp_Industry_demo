-- Razorpay payment links for Tacksharp's own invoices (additive only).
ALTER TABLE `PlatformInvoice`
  ADD COLUMN `paymentLinkId` VARCHAR(64) NULL,
  ADD COLUMN `paymentLinkUrl` VARCHAR(300) NULL,
  ADD COLUMN `paymentLinkStatus` VARCHAR(20) NULL,
  ADD UNIQUE INDEX `PlatformInvoice_paymentLinkId_key`(`paymentLinkId`);

-- Each Razorpay webhook event is applied once (x-razorpay-event-id).
CREATE TABLE `PaymentWebhookEvent` (
  `id` VARCHAR(191) NOT NULL,
  `provider` VARCHAR(20) NOT NULL,
  `eventId` VARCHAR(100) NOT NULL,
  `event` VARCHAR(60) NOT NULL,
  `outcome` VARCHAR(200) NOT NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `PaymentWebhookEvent_provider_eventId_key`(`provider`, `eventId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
