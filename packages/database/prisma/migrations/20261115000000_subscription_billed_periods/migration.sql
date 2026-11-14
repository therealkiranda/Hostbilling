ALTER TABLE "Subscription" ADD COLUMN "billedPeriods" INTEGER NOT NULL DEFAULT 0;

-- Subscriptions that have already started have been through exactly one billing period.
UPDATE "Subscription" SET "billedPeriods" = 1 WHERE "startedAt" IS NOT NULL;
