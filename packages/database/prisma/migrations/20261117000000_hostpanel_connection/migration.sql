CREATE TYPE "PanelState" AS ENUM ('NOT_SYNCED', 'ACTIVE', 'SUSPENDED', 'TERMINATED');

ALTER TABLE "Subscription"
    ADD COLUMN "panelState" "PanelState" NOT NULL DEFAULT 'NOT_SYNCED',
    ADD COLUMN "panelSyncedAt" TIMESTAMP(3),
    ADD COLUMN "panelError" VARCHAR(500);

CREATE TABLE "HostPanelConnection" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "baseUrl" VARCHAR(300) NOT NULL,
    "apiKeyCiphertext" TEXT NOT NULL,
    "defaultType" VARCHAR(16) NOT NULL DEFAULT 'php',
    "defaultPhp" VARCHAR(8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostPanelConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HostPanelConnection_tenantId_key" ON "HostPanelConnection"("tenantId");

ALTER TABLE "HostPanelConnection"
    ADD CONSTRAINT "HostPanelConnection_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
