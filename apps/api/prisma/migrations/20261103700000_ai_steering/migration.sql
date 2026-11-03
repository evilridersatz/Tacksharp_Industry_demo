-- Live AI steering (additive only): per-conversation AI mode and private team guidance. Existing conversations stay
-- 'auto' (unchanged behaviour) with no guidance.
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `aiMode` VARCHAR(10) NOT NULL DEFAULT 'auto';
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `aiGuidance` VARCHAR(500) NULL;
ALTER TABLE `Conversation` ADD COLUMN IF NOT EXISTS `aiGuidanceUntil` DATETIME(3) NULL;
