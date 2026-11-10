CREATE TABLE "McpOAuthRecord" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "McpOAuthRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "McpOAuthRecord_expiresAt_idx" ON "McpOAuthRecord"("expiresAt");
