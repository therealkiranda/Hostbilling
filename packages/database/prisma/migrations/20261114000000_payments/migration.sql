CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'CASH', 'MOBILE_WALLET', 'OTHER');
CREATE TYPE "PaymentStatus" AS ENUM ('COMPLETED', 'REVERSED');

CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'COMPLETED',
    "amountMinorUnits" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "activeKey" TEXT,
    "recordedByUserId" UUID NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payment_tenantId_activeKey_key" ON "Payment"("tenantId", "activeKey");
CREATE INDEX "Payment_tenantId_status_createdAt_idx" ON "Payment"("tenantId", "status", "createdAt");
CREATE INDEX "Payment_tenantId_invoiceId_idx" ON "Payment"("tenantId", "invoiceId");
CREATE INDEX "Payment_tenantId_customerId_idx" ON "Payment"("tenantId", "customerId");

ALTER TABLE "Payment"
    ADD CONSTRAINT "Payment_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment"
    ADD CONSTRAINT "Payment_invoiceId_tenantId_fkey"
    FOREIGN KEY ("invoiceId", "tenantId") REFERENCES "Invoice"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment"
    ADD CONSTRAINT "Payment_customerId_tenantId_fkey"
    FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
