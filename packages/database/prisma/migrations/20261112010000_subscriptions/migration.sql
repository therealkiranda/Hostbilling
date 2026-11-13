CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED');

CREATE UNIQUE INDEX "HostingPlan_id_tenantId_key" ON "HostingPlan"("id", "tenantId");
CREATE UNIQUE INDEX "Customer_id_tenantId_key" ON "Customer"("id", "tenantId");

CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "priceMinorUnits" INTEGER NOT NULL,
    "setupFeeMinorUnits" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL,
    "intervalCount" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Subscription_tenantId_status_createdAt_idx" ON "Subscription"("tenantId", "status", "createdAt");
CREATE INDEX "Subscription_tenantId_customerId_idx" ON "Subscription"("tenantId", "customerId");
CREATE INDEX "Subscription_tenantId_planId_idx" ON "Subscription"("tenantId", "planId");
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");

ALTER TABLE "Subscription"
    ADD CONSTRAINT "Subscription_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Subscription"
    ADD CONSTRAINT "Subscription_customerId_tenantId_fkey"
    FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Subscription"
    ADD CONSTRAINT "Subscription_planId_tenantId_fkey"
    FOREIGN KEY ("planId", "tenantId") REFERENCES "HostingPlan"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
