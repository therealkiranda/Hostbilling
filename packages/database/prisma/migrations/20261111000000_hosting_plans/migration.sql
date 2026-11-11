CREATE TYPE "HostingPlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');

CREATE TABLE "HostingPlan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "HostingPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "priceMinorUnits" INTEGER NOT NULL,
    "setupFeeMinorUnits" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL,
    "intervalCount" INTEGER NOT NULL DEFAULT 1,
    "diskQuotaMb" INTEGER NOT NULL,
    "bandwidthQuotaMb" INTEGER NOT NULL,
    "maxDomains" INTEGER NOT NULL DEFAULT 1,
    "maxEmailAccounts" INTEGER NOT NULL DEFAULT 0,
    "maxDatabases" INTEGER NOT NULL DEFAULT 0,
    "maxFtpAccounts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostingPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HostingPlan_tenantId_slug_key" ON "HostingPlan"("tenantId", "slug");
CREATE INDEX "HostingPlan_tenantId_status_idx" ON "HostingPlan"("tenantId", "status");

ALTER TABLE "HostingPlan"
    ADD CONSTRAINT "HostingPlan_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
