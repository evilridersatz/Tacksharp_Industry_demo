-- Drip A/B variants (additive only): which message variant a step run used (NULL = the step has a single message).
ALTER TABLE `DripStepRun` ADD COLUMN `variant` VARCHAR(1) NULL;
