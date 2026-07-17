CREATE TYPE "OperationSource" AS ENUM ('web', 'mcp', 'system');
CREATE TYPE "OperationAuditPhase" AS ENUM ('requested', 'confirmation_required', 'confirmed', 'dispatched', 'succeeded', 'failed');
CREATE TYPE "IdempotentOperationStatus" AS ENUM ('accepted', 'succeeded', 'failed');

CREATE TABLE "OperationConfirmation" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "oauthClientId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "argumentsHash" TEXT NOT NULL,
  "targetSnapshot" JSONB,
  "idempotencyKey" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OperationConfirmation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IdempotentOperation" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "argumentsHash" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "status" "IdempotentOperationStatus" NOT NULL DEFAULT 'accepted',
  "result" JSONB,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "IdempotentOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationAuditEvent" (
  "id" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "source" "OperationSource" NOT NULL,
  "oauthClientId" TEXT,
  "toolName" TEXT NOT NULL,
  "phase" "OperationAuditPhase" NOT NULL,
  "targetType" TEXT,
  "targetId" TEXT,
  "sanitizedInput" JSONB,
  "jobId" TEXT,
  "errorCode" TEXT,
  "durationMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OperationAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperationConfirmation_actorUserId_createdAt_idx" ON "OperationConfirmation"("actorUserId", "createdAt");
CREATE INDEX "OperationConfirmation_expiresAt_idx" ON "OperationConfirmation"("expiresAt");
CREATE UNIQUE INDEX "IdempotentOperation_operationId_key" ON "IdempotentOperation"("operationId");
CREATE UNIQUE INDEX "IdempotentOperation_actorUserId_toolName_idempotencyKey_key" ON "IdempotentOperation"("actorUserId", "toolName", "idempotencyKey");
CREATE INDEX "IdempotentOperation_status_updatedAt_idx" ON "IdempotentOperation"("status", "updatedAt");
CREATE INDEX "OperationAuditEvent_operationId_createdAt_idx" ON "OperationAuditEvent"("operationId", "createdAt");
CREATE INDEX "OperationAuditEvent_actorUserId_createdAt_idx" ON "OperationAuditEvent"("actorUserId", "createdAt");
CREATE INDEX "OperationAuditEvent_source_createdAt_idx" ON "OperationAuditEvent"("source", "createdAt");
CREATE INDEX "OperationAuditEvent_targetType_targetId_createdAt_idx" ON "OperationAuditEvent"("targetType", "targetId", "createdAt");
CREATE INDEX "OperationAuditEvent_jobId_phase_createdAt_id_idx" ON "OperationAuditEvent"("jobId", "phase", "createdAt", "id");
CREATE INDEX "OperationAuditEvent_createdAt_id_idx" ON "OperationAuditEvent"("createdAt", "id");
