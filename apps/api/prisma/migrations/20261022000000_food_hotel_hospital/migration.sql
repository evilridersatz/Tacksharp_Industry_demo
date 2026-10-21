-- Food ordering, hotel & room booking, hospital & healthcare, and agent conversation state.
-- ADDITIVE ONLY: nullable / defaulted columns on MenuItem, Order and OrderItem (existing GR Chicken rows keep their
-- meaning: fulfilment defaults to 'pickup', fees and tax to 0) and new tables. Idempotent (IF NOT EXISTS).
-- Back up first:  mysqldump <db> > backup.sql   then:  npx prisma migrate deploy

ALTER TABLE `MenuItem` ADD COLUMN IF NOT EXISTS `variants` JSON NULL;
ALTER TABLE `MenuItem` ADD COLUMN IF NOT EXISTS `addOns` JSON NULL;
ALTER TABLE `MenuItem` ADD COLUMN IF NOT EXISTS `taxRatePct` DECIMAL(5, 2) NULL;
ALTER TABLE `MenuItem` ADD COLUMN IF NOT EXISTS `isVeg` BOOLEAN NULL;

ALTER TABLE `Order` ADD COLUMN IF NOT EXISTS `fulfilment` VARCHAR(191) NOT NULL DEFAULT 'pickup';
ALTER TABLE `Order` ADD COLUMN IF NOT EXISTS `deliveryAddress` TEXT NULL;
ALTER TABLE `Order` ADD COLUMN IF NOT EXISTS `deliveryZone` VARCHAR(191) NULL;
ALTER TABLE `Order` ADD COLUMN IF NOT EXISTS `deliveryFee` DECIMAL(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE `Order` ADD COLUMN IF NOT EXISTS `taxAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE `Order` ADD COLUMN IF NOT EXISTS `dispatchedAt` DATETIME(3) NULL;

ALTER TABLE `OrderItem` ADD COLUMN IF NOT EXISTS `variant` VARCHAR(191) NULL;
ALTER TABLE `OrderItem` ADD COLUMN IF NOT EXISTS `addOns` JSON NULL;

CREATE TABLE IF NOT EXISTS `AgentSession` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `data` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `AgentSession_organizationId_updatedAt_idx`(`organizationId`, `updatedAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `AgentSession_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `RoomType` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `bedType` VARCHAR(191) NULL,
    `sizeSqft` INTEGER NULL,
    `maxAdults` INTEGER NOT NULL DEFAULT 2,
    `maxChildren` INTEGER NOT NULL DEFAULT 1,
    `maxOccupancy` INTEGER NOT NULL DEFAULT 3,
    `baseRate` DECIMAL(10, 2) NOT NULL,
    `weekendRate` DECIMAL(10, 2) NULL,
    `amenities` JSON NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `RoomType_organizationId_code_key`(`organizationId`, `code`),
    INDEX `RoomType_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `RoomType_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Room` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `roomTypeId` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `floor` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'available',
    `housekeeping` VARCHAR(191) NOT NULL DEFAULT 'clean',
    `notes` TEXT NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `Room_organizationId_number_key`(`organizationId`, `number`),
    INDEX `Room_roomTypeId_idx`(`roomTypeId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `Room_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `Room_roomTypeId_fkey` FOREIGN KEY (`roomTypeId`) REFERENCES `RoomType`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `RoomRate` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `roomTypeId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `startDate` DATE NOT NULL,
    `endDate` DATE NOT NULL,
    `rate` DECIMAL(10, 2) NOT NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `RoomRate_roomTypeId_startDate_idx`(`roomTypeId`, `startDate`),
    INDEX `RoomRate_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `RoomRate_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `RoomRate_roomTypeId_fkey` FOREIGN KEY (`roomTypeId`) REFERENCES `RoomType`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Reservation` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NULL,
    `roomTypeId` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NULL,
    `checkIn` DATE NOT NULL,
    `checkOut` DATE NOT NULL,
    `nights` INTEGER NOT NULL,
    `rooms` INTEGER NOT NULL DEFAULT 1,
    `adults` INTEGER NOT NULL,
    `children` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending_confirmation',
    `holdExpiresAt` DATETIME(3) NULL,
    `subtotal` DECIMAL(10, 2) NOT NULL,
    `taxAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `total` DECIMAL(10, 2) NOT NULL,
    `rateBreakdown` JSON NOT NULL,
    `paymentStatus` VARCHAR(191) NOT NULL DEFAULT 'not_required',
    `depositAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `channel` VARCHAR(191) NOT NULL,
    `guestName` VARCHAR(191) NULL,
    `guestPhone` VARCHAR(191) NULL,
    `specialRequests` TEXT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `cancellationReason` TEXT NULL,
    `cancelledAt` DATETIME(3) NULL,
    `checkedInAt` DATETIME(3) NULL,
    `checkedOutAt` DATETIME(3) NULL,
    `feedbackRating` INTEGER NULL,
    `feedbackComment` TEXT NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `Reservation_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    UNIQUE INDEX `Reservation_organizationId_reference_key`(`organizationId`, `reference`),
    INDEX `Reservation_organizationId_checkIn_idx`(`organizationId`, `checkIn`),
    INDEX `Reservation_roomTypeId_checkIn_checkOut_idx`(`roomTypeId`, `checkIn`, `checkOut`),
    INDEX `Reservation_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `Reservation_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `Reservation_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `Reservation_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `Reservation_roomTypeId_fkey` FOREIGN KEY (`roomTypeId`) REFERENCES `RoomType`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `Reservation_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `Room`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Department` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `Department_organizationId_name_key`(`organizationId`, `name`),
    PRIMARY KEY (`id`),
    CONSTRAINT `Department_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Doctor` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `departmentId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `qualification` VARCHAR(191) NULL,
    `specialty` VARCHAR(191) NULL,
    `languages` VARCHAR(191) NULL,
    `consultationFee` DECIMAL(10, 2) NOT NULL,
    `slotMinutes` INTEGER NOT NULL DEFAULT 15,
    `schedule` JSON NOT NULL,
    `leaveDates` JSON NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `Doctor_organizationId_idx`(`organizationId`),
    INDEX `Doctor_departmentId_idx`(`departmentId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `Doctor_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `Doctor_departmentId_fkey` FOREIGN KEY (`departmentId`) REFERENCES `Department`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `Appointment` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `departmentId` VARCHAR(191) NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'booked',
    `visitType` VARCHAR(191) NOT NULL DEFAULT 'new',
    `reasonNote` TEXT NULL,
    `channel` VARCHAR(191) NOT NULL,
    `patientName` VARCHAR(191) NULL,
    `patientPhone` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `rescheduledFrom` VARCHAR(191) NULL,
    `cancellationReason` TEXT NULL,
    `feedbackRating` INTEGER NULL,
    `feedbackComment` TEXT NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `Appointment_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    UNIQUE INDEX `Appointment_organizationId_reference_key`(`organizationId`, `reference`),
    INDEX `Appointment_doctorId_startAt_idx`(`doctorId`, `startAt`),
    INDEX `Appointment_organizationId_startAt_idx`(`organizationId`, `startAt`),
    INDEX `Appointment_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `Appointment_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `Appointment_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `Appointment_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `Appointment_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `Doctor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `Appointment_departmentId_fkey` FOREIGN KEY (`departmentId`) REFERENCES `Department`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `InsuranceCase` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NULL,
    `kind` VARCHAR(191) NOT NULL,
    `insurer` VARCHAR(191) NOT NULL,
    `tpa` VARCHAR(191) NULL,
    `policyRef` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'documents_pending',
    `requiredDocs` JSON NOT NULL,
    `receivedDocs` JSON NOT NULL,
    `amountRequested` DECIMAL(12, 2) NULL,
    `amountApproved` DECIMAL(12, 2) NULL,
    `insurerReference` VARCHAR(191) NULL,
    `decisionNote` TEXT NULL,
    `decidedBy` VARCHAR(191) NULL,
    `lastFollowUpAt` DATETIME(3) NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `InsuranceCase_organizationId_reference_key`(`organizationId`, `reference`),
    INDEX `InsuranceCase_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `InsuranceCase_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `InsuranceCase_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `InsuranceCase_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
