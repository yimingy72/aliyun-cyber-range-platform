-- Preserve official fractional charges beyond nine decimal places without rounding existing history.
ALTER TABLE "BillingLineItem" ALTER COLUMN "pretaxAmount" TYPE DECIMAL(30, 18);
ALTER TABLE "BillingAnomaly" ALTER COLUMN "pretaxAmount" TYPE DECIMAL(30, 18);
