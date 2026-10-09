import { ConflictException, HttpException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import type { AuthenticatedPlatformRequest, RequestAuthContext } from '../auth/request-auth-context';
import { ADMIN_REPOSITORY, type IdempotentOperationRecord, type OperationAuditEventInput } from '../admin/admin.repository';
import type { AdminRepository } from '../admin/admin.repository';
import { requireCurrentCloudWorkspaceId } from '../auth/cloud-workspace-scope';

const SENSITIVE_KEYS = new Set(['password', 'defaultPassword', 'token', 'accessToken', 'refreshToken', 'vncUrl', 'webTerminalUrl', 'accessKeyId', 'accessKeySecret']);
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export type OperationRequestMetadata = {
  requestId: string;
  idempotencyKey: string | null;
  confirmationId: string | null;
};

export function readOperationRequestMetadata(request: AuthenticatedPlatformRequest): OperationRequestMetadata {
  return {
    requestId: readHeader(request, 'x-request-id') ?? randomUUID(),
    idempotencyKey: readHeader(request, 'x-idempotency-key') ?? readHeader(request, 'idempotency-key'),
    confirmationId: readHeader(request, 'x-confirmation-id') ?? readHeader(request, 'x-operation-confirmation-id'),
  };
}

@Injectable()
export class OperationControlService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository) {}

  async audit(input: OperationAuditEventInput) {
    const cloudWorkspaceId = requireCurrentCloudWorkspaceId();
    if (input.cloudWorkspaceId && input.cloudWorkspaceId !== cloudWorkspaceId) {
      throw new ConflictException('Operation audit does not match the current cloud workspace');
    }
    return this.repository.appendOperationAuditEvent({
      ...input,
      cloudWorkspaceId,
      sanitizedInput: sanitize(input.sanitizedInput ?? null),
    });
  }

  async executeConfirmed<TResult extends Record<string, unknown>>(input: {
    context: RequestAuthContext;
    metadata: OperationRequestMetadata;
    toolName: string;
    arguments: Record<string, unknown>;
    targetType: string;
    targetId?: string | null;
    resolveConfirmation: () => Promise<{ targetId: string | null; targetSnapshot: Record<string, unknown> | null; summary: Record<string, unknown> }>;
    execute: () => Promise<TResult>;
  }) {
    const cloudWorkspaceId = requireCurrentCloudWorkspaceId();
    const argumentsHash = hash({ cloudWorkspaceId, arguments: input.arguments });
    const auditBase = {
      cloudWorkspaceId,
      requestId: input.metadata.requestId,
      actorUserId: input.context.user.id,
      source: input.context.source,
      oauthClientId: input.context.oauthClientId,
      toolName: input.toolName,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      sanitizedInput: input.arguments,
    } satisfies Omit<OperationAuditEventInput, 'operationId' | 'phase'>;

    await this.audit({ ...auditBase, operationId: `request:${input.metadata.requestId}`, phase: 'requested' });

    const confirmation = input.metadata.confirmationId
      ? await this.repository.getOperationConfirmationById(input.metadata.confirmationId)
      : null;
    const idempotencyKey = input.metadata.idempotencyKey ?? confirmation?.idempotencyKey ?? randomUUID();

    if (input.metadata.confirmationId && (
      !confirmation ||
      confirmation.cloudWorkspaceId !== cloudWorkspaceId ||
      confirmation.actorUserId !== input.context.user.id ||
      confirmation.oauthClientId !== (input.context.oauthClientId ?? 'web') ||
      confirmation.toolName !== input.toolName ||
      confirmation.argumentsHash !== argumentsHash ||
      confirmation.idempotencyKey !== idempotencyKey
    )) {
      throw new ConflictException('Operation confirmation does not match this request');
    }

    const existing = await this.repository.getIdempotentOperation(
      input.context.user.id,
      input.toolName,
      idempotencyKey,
    );
    if (existing) {
      return this.existing(existing, argumentsHash, cloudWorkspaceId);
    }

    if (!input.metadata.confirmationId) {
      const resolved = await input.resolveConfirmation();
      const confirmation = await this.repository.createOperationConfirmation({
        cloudWorkspaceId,
        actorUserId: input.context.user.id,
        oauthClientId: input.context.oauthClientId ?? 'web',
        toolName: input.toolName,
        argumentsHash,
        targetSnapshot: sanitize(resolved.targetSnapshot),
        idempotencyKey,
        expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
      });

      await this.audit({
        ...auditBase,
        operationId: confirmation.id,
        phase: 'confirmation_required',
        targetId: resolved.targetId,
        errorCode: 'CONFIRMATION_REQUIRED',
      });

      throw new ConflictException({
        code: 'CONFIRMATION_REQUIRED',
        confirmationId: confirmation.id,
        idempotencyKey,
        summary: resolved.summary,
      });
    }

    if (
      !confirmation ||
      !(await this.repository.consumeOperationConfirmation(confirmation.id, new Date()))
    ) {
      throw new ConflictException('Operation confirmation does not match this request');
    }

    await this.audit({ ...auditBase, operationId: confirmation.id, phase: 'confirmed' });

    const operation = await this.begin(cloudWorkspaceId, input.context.user.id, input.toolName, idempotencyKey, argumentsHash);
    if ('existing' in operation && operation.existing) {
      return this.existing(operation.existing, argumentsHash, cloudWorkspaceId);
    }

    try {
      const result = await input.execute();
      const jobId = typeof result.jobId === 'string' ? result.jobId : null;
      if (jobId) {
        await this.audit({ ...auditBase, operationId: operation.operationId, phase: 'dispatched', jobId });
      } else {
        await this.repository.updateIdempotentOperation(operation.id, { status: 'succeeded', result, errorCode: null });
        await this.audit({ ...auditBase, operationId: operation.operationId, phase: 'succeeded' });
      }
      return { operationId: operation.operationId, ...result };
    } catch (error) {
      const errorCode = errorCodeFor(error);
      await this.repository.updateIdempotentOperation(operation.id, { status: 'failed', errorCode });
      await this.audit({ ...auditBase, operationId: operation.operationId, phase: 'failed', errorCode });
      throw error;
    }
  }

  private async begin(cloudWorkspaceId: string, actorUserId: string, toolName: string, idempotencyKey: string, argumentsHash: string) {
    const operationId = randomUUID();
    try {
      const operation = await this.repository.createIdempotentOperation({ cloudWorkspaceId, actorUserId, toolName, idempotencyKey, argumentsHash, operationId });
      return { id: operation.id, operationId };
    } catch (error) {
      const existing = await this.repository.getIdempotentOperation(actorUserId, toolName, idempotencyKey);
      if (existing) {
        return { existing };
      }
      throw error;
    }
  }

  private existing(operation: IdempotentOperationRecord, argumentsHash: string, cloudWorkspaceId: string) {
    if (operation.cloudWorkspaceId !== cloudWorkspaceId || operation.argumentsHash !== argumentsHash) {
      throw new ConflictException('Operation idempotency key is already bound to different arguments');
    }
    return {
      operationId: operation.operationId,
      status: operation.status,
      result: operation.result,
      errorCode: operation.errorCode,
    };
  }
}

function readHeader(request: AuthenticatedPlatformRequest, name: string) {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('base64url');
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)]));
}

function sanitize(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEYS.has(key))
      .map(([key, child]) => [key, Array.isArray(child) ? child.map((item) => sanitize(item) ?? item) : sanitize(child) ?? child]),
  );
}

function errorCodeFor(error: unknown) {
  if (error instanceof HttpException) {
    return `HTTP_${error.getStatus()}`;
  }
  return 'INTERNAL_ERROR';
}
