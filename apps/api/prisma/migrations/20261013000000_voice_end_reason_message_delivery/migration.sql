-- Additive only: no data is changed or removed.

-- Why a call ended (our goodbye / max turns / no response, or the customer / network hung up).
ALTER TABLE `Call` ADD COLUMN `endReason` VARCHAR(191) NULL;

-- Delivery state of WhatsApp messages we sent (matched on the provider id in externalId).
ALTER TABLE `Message` ADD COLUMN `deliveryStatus` VARCHAR(191) NULL,
    ADD COLUMN `deliveryError` VARCHAR(500) NULL,
    ADD COLUMN `deliveryUpdatedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Message_organizationId_externalId_idx` ON `Message`(`organizationId`, `externalId`);
