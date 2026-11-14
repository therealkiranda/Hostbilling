CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PAID', 'VOID');

ALTER TABLE "Tenant" ADD COLUMN "invoiceCounter" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Subscription_id_tenantId_key" ON "Subscription"("id", "tenantId");

CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "currency" VARCHAR(3) NOT NULL,
    "subtotalMinorUnits" INTEGER NOT NULL,
    "totalMinorUnits" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "periodKey" TEXT,
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvoiceLineItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitAmountMinorUnits" INTEGER NOT NULL,
    "amountMinorUnits" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invoice_id_tenantId_key" ON "Invoice"("id", "tenantId");
CREATE UNIQUE INDEX "Invoice_tenantId_number_key" ON "Invoice"("tenantId", "number");
CREATE UNIQUE INDEX "Invoice_tenantId_periodKey_key" ON "Invoice"("tenantId", "periodKey");
CREATE INDEX "Invoice_tenantId_status_createdAt_idx" ON "Invoice"("tenantId", "status", "createdAt");
CREATE INDEX "Invoice_tenantId_customerId_idx" ON "Invoice"("tenantId", "customerId");
CREATE INDEX "Invoice_tenantId_subscriptionId_idx" ON "Invoice"("tenantId", "subscriptionId");
CREATE INDEX "InvoiceLineItem_tenantId_invoiceId_idx" ON "InvoiceLineItem"("tenantId", "invoiceId");

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_customerId_tenantId_fkey"
    FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_subscriptionId_tenantId_fkey"
    FOREIGN KEY ("subscriptionId", "tenantId") REFERENCES "Subscription"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InvoiceLineItem"
    ADD CONSTRAINT "InvoiceLineItem_invoiceId_tenantId_fkey"
    FOREIGN KEY ("invoiceId", "tenantId") REFERENCES "Invoice"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
