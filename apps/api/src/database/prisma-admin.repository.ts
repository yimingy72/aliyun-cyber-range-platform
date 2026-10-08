import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';

import { Prisma } from '@aliyun-cyber-range/database/generated/client';
import {
  AdminRepository,
  BillingAnomalyRecord,
  BillingLedgerResourceRecord,
  BillingLineItemRecord,
  CloudProvider,
  CloudResourceDriftRecord,
  CloudImageSnapshotRecord,
  CollectImageCatalogItemInput,
  CollectPlatformImageAssetInput,
  CompleteRangeInstanceDraftApplyInput,
  CreatePlatformImageTagInput,
  CreateBillingAnomalyInput,
  CreateBillingLedgerResourceInput,
  CreateBillingLineItemInput,
  CreateIdempotentOperationInput,
  CreateOperationConfirmationInput,
  CreatePlatformUserInput,
  CreateProvisionJobInput,
  QueueRangeInstanceJobInput,
  ProvisionJobTopologySnapshot,
  CreateProvisionJobStepLogInput,
  CreateSingleInstanceBatchInput,
  CreateRangeInstanceInput,
  CreateRangeTemplateInput,
  ApplyRangeInstanceDraftInput,
  FindBillingLedgerResourceInput,
  ImageCatalogItemRecord,
  IdempotentOperationRecord,
  ListBillingAnomaliesFilter,
  ListBillingLineItemsFilter,
  ListImageCatalogItemsFilter,
  ListImageSnapshotsFilter,
  ListPlatformImageAssetsFilter,
  OperationAuditEventInput,
  OperationAuditEventRecord,
  OperationConfirmationRecord,
  PlatformUserRecord,
  PlatformImageAssetRecord,
  PlatformImageTagRecord,
  ProvisionJobRecord,
  ProvisionJobStepLogRecord,
  ReconcileImageSnapshotsInput,
  RangeInstanceRecord,
  RangeInstanceDraftRevisionConflictError,
  SaveRangeInstanceDraftInput,
  SyncRangeInstanceDraftToTemplateInput,
  SingleInstanceBatchRecord,
  SingleInstanceBatchWithInstancesRecord,
  RangeTemplateRecord,
  SaveRangeTemplateTopologyInput,
  TemplateRevisionConflictError,
  UpsertImageSnapshotsInput,
  UpsertCloudResourceDriftInput,
  UpdateBillingLedgerResourceInput,
  UpdateIdempotentOperationInput,
  UpdatePlatformUserInput,
  UpdateProvisionJobInput,
  UpdateProvisionJobStepLogInput,
  UpdateRangeInstanceInput,
  UpdateRangeTemplateMetadataInput,
} from '../admin/admin.repository';
import { toAccountScopeKey } from '../admin/image-account-scope';
import { PrismaService } from './prisma.service';

function isSerializableTransactionConflict(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    return true;
  }

  return error instanceof Error && /could not serialize access|write conflict|deadlock/i.test(error.message);
}

function toBillingLineItemRecord(
  record: {
    id: string;
    cloudAccountUid: string | null;
    syncBatchId: string;
    sourceFingerprint: string;
    billCycle: string;
    billingDate: Date;
    productCode: string;
    productDetail: string | null;
    billItem: string;
    cloudResourceId: string;
    cloudResourceType: BillingLineItemRecord['cloudResourceType'];
    pretaxAmount: Prisma.Decimal;
    currency: string;
    billingScope: BillingLineItemRecord['billingScope'];
    ownerUserId: string | null;
    matchedLedgerId: string | null;
    rawPayload: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
  },
): BillingLineItemRecord {
  return {
    ...record,
    pretaxAmount: Number(record.pretaxAmount),
    rawPayload: (record.rawPayload ?? {}) as Record<string, unknown>,
  };
}

function toBillingAnomalyRecord(
  record: {
    id: string;
    cloudAccountUid: string | null;
    syncBatchId: string;
    sourceFingerprint: string;
    billCycle: string;
    billingDate: Date;
    cloudResourceId: string;
    cloudResourceType: BillingAnomalyRecord['cloudResourceType'];
    pretaxAmount: Prisma.Decimal;
    currency: string;
    reason: string;
    rawPayload: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
  },
): BillingAnomalyRecord {
  return {
    ...record,
    pretaxAmount: Number(record.pretaxAmount),
    rawPayload: (record.rawPayload ?? {}) as Record<string, unknown>,
  };
}

function toCloudResourceDriftRecord(record: {
  id: string;
  cloudProvider: CloudResourceDriftRecord['cloudProvider'];
  regionId: string;
  cloudResourceType: string;
  cloudResourceId: string;
  rangeInstanceId: string | null;
  severity: CloudResourceDriftRecord['severity'];
  reason: string;
  tagsSnapshot: Prisma.JsonValue;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): CloudResourceDriftRecord {
  return {
    ...record,
    tagsSnapshot: (record.tagsSnapshot ?? {}) as Record<string, unknown>,
  };
}

function toOperationJson(value: Record<string, unknown> | null) {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function toOperationConfirmationRecord(record: {
  id: string;
  actorUserId: string;
  oauthClientId: string;
  toolName: string;
  argumentsHash: string;
  targetSnapshot: Prisma.JsonValue | null;
  idempotencyKey: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}): OperationConfirmationRecord {
  return {
    ...record,
    targetSnapshot: (record.targetSnapshot ?? null) as Record<string, unknown> | null,
  };
}

function toIdempotentOperationRecord(record: {
  id: string;
  actorUserId: string;
  toolName: string;
  idempotencyKey: string;
  argumentsHash: string;
  operationId: string;
  status: IdempotentOperationRecord['status'];
  result: Prisma.JsonValue | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}): IdempotentOperationRecord {
  return {
    ...record,
    result: (record.result ?? null) as Record<string, unknown> | null,
  };
}

const platformImageAssetTagInclude = {
  tags: {
    include: {
      tag: true,
    },
    orderBy: {
      tag: {
        name: 'asc',
      },
    },
  },
} as const;

type PlatformImageAssetWithTags = Omit<PlatformImageAssetRecord, 'tags'> & {
  tags: Array<{ tag: PlatformImageTagRecord }>;
};

function toPlatformImageAssetRecord(record: PlatformImageAssetWithTags): PlatformImageAssetRecord {
  const { tags, ...asset } = record;

  return {
    ...asset,
    tags: tags.map((entry) => entry.tag),
  };
}

function toOperationAuditEventRecord(record: {
  id: string;
  operationId: string;
  requestId: string;
  actorUserId: string;
  source: OperationAuditEventRecord['source'];
  oauthClientId: string | null;
  toolName: string;
  phase: OperationAuditEventRecord['phase'];
  targetType: string | null;
  targetId: string | null;
  sanitizedInput: Prisma.JsonValue | null;
  jobId: string | null;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: Date;
}): OperationAuditEventRecord {
  return {
    ...record,
    sanitizedInput: (record.sanitizedInput ?? null) as Record<string, unknown> | null,
  };
}

@Injectable()
export class PrismaAdminRepository implements AdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createPlatformUser(input: CreatePlatformUserInput): Promise<PlatformUserRecord> {
    return this.prisma.platformUser.create({
      data: {
        id: input.id,
        username: input.username,
        passwordHash: input.passwordHash,
        oidcIssuer: input.oidcIssuer ?? null,
        oidcSubject: input.oidcSubject ?? null,
        role: input.role,
        status: input.status ?? 'active',
      },
    }) as Promise<PlatformUserRecord>;
  }

  async listPlatformUsers(): Promise<PlatformUserRecord[]> {
    return this.prisma.platformUser.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    }) as Promise<PlatformUserRecord[]>;
  }

  async getPlatformUserById(id: string): Promise<PlatformUserRecord | null> {
    return this.prisma.platformUser.findUnique({
      where: { id },
    }) as Promise<PlatformUserRecord | null>;
  }

  async getPlatformUserByUsername(username: string): Promise<PlatformUserRecord | null> {
    return this.prisma.platformUser.findUnique({
      where: { username },
    }) as Promise<PlatformUserRecord | null>;
  }

  async getPlatformUserByOidcIdentity(issuer: string, subject: string): Promise<PlatformUserRecord | null> {
    return this.prisma.platformUser.findUnique({
      where: {
        oidcIssuer_oidcSubject: {
          oidcIssuer: issuer,
          oidcSubject: subject,
        },
      },
    }) as Promise<PlatformUserRecord | null>;
  }

  async updatePlatformUser(id: string, input: UpdatePlatformUserInput): Promise<PlatformUserRecord> {
    return this.prisma.platformUser.update({
      where: { id },
      data: {
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.passwordHash !== undefined ? { passwordHash: input.passwordHash } : {}),
        ...(input.oidcIssuer !== undefined ? { oidcIssuer: input.oidcIssuer } : {}),
        ...(input.oidcSubject !== undefined ? { oidcSubject: input.oidcSubject } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    }) as Promise<PlatformUserRecord>;
  }

  async countActiveAdmins(): Promise<number> {
    return this.prisma.platformUser.count({
      where: {
        role: 'admin',
        status: 'active',
      },
    });
  }

  async createOperationConfirmation(input: CreateOperationConfirmationInput): Promise<OperationConfirmationRecord> {
    return toOperationConfirmationRecord(
      await this.prisma.operationConfirmation.create({
        data: {
          ...input,
          targetSnapshot: toOperationJson(input.targetSnapshot),
        },
      }),
    );
  }

  async getOperationConfirmationById(id: string): Promise<OperationConfirmationRecord | null> {
    const record = await this.prisma.operationConfirmation.findUnique({ where: { id } });
    return record ? toOperationConfirmationRecord(record) : null;
  }

  async consumeOperationConfirmation(id: string, consumedAt: Date): Promise<OperationConfirmationRecord | null> {
    const updated = await this.prisma.operationConfirmation.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: consumedAt } },
      data: { consumedAt },
    });

    if (updated.count !== 1) {
      return null;
    }

    return this.getOperationConfirmationById(id);
  }

  async createIdempotentOperation(input: CreateIdempotentOperationInput): Promise<IdempotentOperationRecord> {
    return toIdempotentOperationRecord(await this.prisma.idempotentOperation.create({ data: input }));
  }

  async getIdempotentOperation(actorUserId: string, toolName: string, idempotencyKey: string): Promise<IdempotentOperationRecord | null> {
    const record = await this.prisma.idempotentOperation.findUnique({
      where: { actorUserId_toolName_idempotencyKey: { actorUserId, toolName, idempotencyKey } },
    });
    return record ? toIdempotentOperationRecord(record) : null;
  }

  async getIdempotentOperationByOperationId(operationId: string): Promise<IdempotentOperationRecord | null> {
    const record = await this.prisma.idempotentOperation.findUnique({ where: { operationId } });
    return record ? toIdempotentOperationRecord(record) : null;
  }

  async updateIdempotentOperation(id: string, input: UpdateIdempotentOperationInput): Promise<IdempotentOperationRecord> {
    return toIdempotentOperationRecord(
      await this.prisma.idempotentOperation.update({
        where: { id },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.result !== undefined ? { result: toOperationJson(input.result) } : {}),
          ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        },
      }),
    );
  }

  async appendOperationAuditEvent(input: OperationAuditEventInput): Promise<OperationAuditEventRecord> {
    return toOperationAuditEventRecord(
      await this.prisma.operationAuditEvent.create({
        data: {
          operationId: input.operationId,
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          source: input.source,
          oauthClientId: input.oauthClientId ?? null,
          toolName: input.toolName,
          phase: input.phase,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          sanitizedInput: toOperationJson(input.sanitizedInput ?? null),
          jobId: input.jobId ?? null,
          errorCode: input.errorCode ?? null,
          durationMs: input.durationMs ?? null,
        },
      }),
    );
  }

  async getDispatchedOperationByJobId(jobId: string): Promise<OperationAuditEventRecord | null> {
    const record = await this.prisma.operationAuditEvent.findFirst({
      where: { jobId, phase: 'dispatched' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return record ? toOperationAuditEventRecord(record) : null;
  }

  async listRangeTemplates(): Promise<RangeTemplateRecord[]> {
    return this.prisma.rangeTemplate.findMany({
      include: {
        currentDraftVersion: true,
        currentPublishedVersion: true,
        versions: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    }) as Promise<RangeTemplateRecord[]>;
  }

  async getRangeTemplateById(id: string): Promise<RangeTemplateRecord | null> {
    return this.prisma.rangeTemplate.findUnique({
      where: {
        id,
      },
      include: {
        currentDraftVersion: true,
        currentPublishedVersion: true,
        versions: true,
      },
    }) as Promise<RangeTemplateRecord | null>;
  }

  async getRangeTemplateVersionById(id: string) {
    return this.prisma.rangeTemplateVersion.findUnique({
      where: { id },
    }) as Promise<import('../admin/admin.repository').RangeTemplateVersionRecord | null>;
  }

  async createRangeTemplate(input: CreateRangeTemplateInput): Promise<RangeTemplateRecord> {
    return this.prisma.$transaction(async (tx) => {
      const template = await tx.rangeTemplate.create({
        data: {
          name: input.name,
          createdBy: input.createdBy ?? 'admin',
          ownerUserId: input.ownerUserId ?? null,
          description: input.description ?? null,
          slug: input.slug,
          version: input.version,
          cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
          iacType: input.iacType ?? 'opentofu',
          modulePathOrRef: input.modulePathOrRef,
          topologySpec: input.topologySpec as Prisma.InputJsonValue,
          topologyGraph: (input.topologyGraph ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
          scenarioTemplateSpec: (input.scenarioTemplateSpec ?? null) as
            | Prisma.InputJsonValue
            | Prisma.NullableJsonNullValueInput,
          compiledProvisionSpec: (input.compiledProvisionSpec ?? null) as
            | Prisma.InputJsonValue
            | Prisma.NullableJsonNullValueInput,
          compiledSpec: (input.compiledSpec ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
          variableSchema: (input.variableSchema ?? {}) as Prisma.InputJsonValue,
          outputSchema: (input.outputSchema ?? {}) as Prisma.InputJsonValue,
          visibility: input.visibility ?? 'private',
          ...(input.defaultNetworkPolicy
            ? {
                defaultNetworkPolicy: input.defaultNetworkPolicy as Prisma.InputJsonValue,
              }
            : {}),
        },
      });

      const draftVersion = await tx.rangeTemplateVersion.create({
        data: {
          templateId: template.id,
          version: input.version,
          status: 'draft',
          modulePathOrRef: input.modulePathOrRef,
          topologySpec: input.topologySpec as Prisma.InputJsonValue,
          topologyGraph: (input.topologyGraph ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
          scenarioTemplateSpec: (input.scenarioTemplateSpec ?? null) as
            | Prisma.InputJsonValue
            | Prisma.NullableJsonNullValueInput,
          compiledProvisionSpec: (input.compiledProvisionSpec ?? null) as
            | Prisma.InputJsonValue
            | Prisma.NullableJsonNullValueInput,
          compiledSpec: (input.compiledSpec ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
          variableSchema: (input.variableSchema ?? {}) as Prisma.InputJsonValue,
          outputSchema: (input.outputSchema ?? {}) as Prisma.InputJsonValue,
          ...(input.defaultNetworkPolicy
            ? {
                defaultNetworkPolicy: input.defaultNetworkPolicy as Prisma.InputJsonValue,
              }
            : {}),
        },
      });

      await tx.rangeTemplate.update({
        where: { id: template.id },
        data: {
          currentDraftVersionId: draftVersion.id,
        },
      });

      return tx.rangeTemplate.findUnique({
        where: { id: template.id },
        include: {
          currentDraftVersion: true,
          currentPublishedVersion: true,
          versions: true,
        },
      }) as Promise<RangeTemplateRecord>;
    });
  }

  async updateRangeTemplateMetadata(
    id: string,
    input: UpdateRangeTemplateMetadataInput,
  ): Promise<RangeTemplateRecord> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.rangeTemplate.findUniqueOrThrow({ where: { id } });

      if (existing.revision !== input.expectedRevision) {
        throw new TemplateRevisionConflictError();
      }

      const changed =
        (input.name !== undefined && input.name !== existing.name) ||
        (input.description !== undefined && input.description !== existing.description);

      if (changed) {
        const updated = await tx.rangeTemplate.updateMany({
          where: {
            id,
            revision: input.expectedRevision,
          },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            revision: { increment: 1 },
          },
        });

        if (updated.count !== 1) {
          throw new TemplateRevisionConflictError();
        }
      }

      return tx.rangeTemplate.findUniqueOrThrow({
        where: { id },
        include: {
          currentDraftVersion: true,
          currentPublishedVersion: true,
          versions: true,
        },
      }) as Promise<RangeTemplateRecord>;
    });
  }

  async saveRangeTemplateTopology(
    id: string,
    input: SaveRangeTemplateTopologyInput,
  ): Promise<RangeTemplateRecord> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.rangeTemplate.findUniqueOrThrow({
        where: { id },
        include: {
          currentDraftVersion: true,
          currentPublishedVersion: true,
        },
      });

      if (existing.revision !== input.expectedRevision) {
        throw new TemplateRevisionConflictError();
      }

      if (!existing.currentDraftVersion) {
        throw new Error('Current editable template snapshot not found');
      }

      const topologyChanged =
        !isDeepStrictEqual(existing.currentDraftVersion.topologySpec, input.topologySpec) ||
        !isDeepStrictEqual(existing.currentDraftVersion.topologyGraph, input.topologyGraph) ||
        !isDeepStrictEqual(existing.currentDraftVersion.scenarioTemplateSpec, input.scenarioTemplateSpec) ||
        !isDeepStrictEqual(existing.currentDraftVersion.compiledProvisionSpec, input.compiledProvisionSpec) ||
        !isDeepStrictEqual(existing.currentDraftVersion.compiledSpec, input.compiledSpec);

      if (topologyChanged) {
        await tx.rangeTemplateVersion.update({
          where: { id: existing.currentDraftVersion.id },
          data: {
            topologySpec: input.topologySpec as Prisma.InputJsonValue,
            topologyGraph: input.topologyGraph as Prisma.InputJsonValue,
            scenarioTemplateSpec: input.scenarioTemplateSpec as Prisma.InputJsonValue,
            compiledProvisionSpec: input.compiledProvisionSpec as Prisma.InputJsonValue,
            compiledSpec: input.compiledSpec as Prisma.InputJsonValue,
          },
        });

        if (existing.currentPublishedVersion) {
          await tx.rangeTemplateVersion.update({
            where: { id: existing.currentPublishedVersion.id },
            data: { status: 'archived' },
          });
        }

        const updated = await tx.rangeTemplate.updateMany({
          where: {
            id,
            revision: input.expectedRevision,
          },
          data: {
            topologySpec: input.topologySpec as Prisma.InputJsonValue,
            topologyGraph: input.topologyGraph as Prisma.InputJsonValue,
            scenarioTemplateSpec: input.scenarioTemplateSpec as Prisma.InputJsonValue,
            compiledProvisionSpec: input.compiledProvisionSpec as Prisma.InputJsonValue,
            compiledSpec: input.compiledSpec as Prisma.InputJsonValue,
            visibility: 'private',
            currentPublishedVersionId: null,
            revision: { increment: 1 },
          },
        });

        if (updated.count !== 1) {
          throw new TemplateRevisionConflictError();
        }
      }

      return tx.rangeTemplate.findUniqueOrThrow({
        where: { id },
        include: {
          currentDraftVersion: true,
          currentPublishedVersion: true,
          versions: true,
        },
      }) as Promise<RangeTemplateRecord>;
    });
  }

  async syncRangeInstanceDraftToTemplate(
    input: SyncRangeInstanceDraftToTemplateInput,
  ): Promise<RangeTemplateRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const instance = await transaction.rangeInstance.findUnique({
        where: { id: input.rangeInstanceId },
      });

      if (
        !instance ||
        instance.status !== 'running' ||
        !instance.templateId ||
        instance.draftRevision !== input.expectedDraftRevision ||
        !instance.draftTopologyGraph ||
        !instance.draftTopologySpec ||
        !instance.draftScenarioTemplateSpec ||
        !instance.draftCompiledProvisionSpec
      ) {
        return null;
      }

      const template = await transaction.rangeTemplate.findUnique({
        where: { id: instance.templateId },
        include: {
          currentDraftVersion: true,
          currentPublishedVersion: true,
        },
      });

      if (
        !template ||
        template.revision !== input.expectedTemplateRevision ||
        !template.currentDraftVersion
      ) {
        return null;
      }

      const guardedInstance = await transaction.rangeInstance.updateMany({
        where: {
          id: instance.id,
          status: 'running',
          draftRevision: input.expectedDraftRevision,
        },
        data: {
          draftRevision: { increment: 0 },
        },
      });

      if (guardedInstance.count !== 1) {
        return null;
      }

      const topologyChanged =
        !isDeepStrictEqual(template.currentDraftVersion.topologySpec, input.topology.topologySpec) ||
        !isDeepStrictEqual(template.currentDraftVersion.topologyGraph, input.topology.topologyGraph) ||
        !isDeepStrictEqual(template.currentDraftVersion.scenarioTemplateSpec, input.topology.scenarioTemplateSpec) ||
        !isDeepStrictEqual(template.currentDraftVersion.compiledProvisionSpec, input.topology.compiledProvisionSpec) ||
        !isDeepStrictEqual(template.currentDraftVersion.compiledSpec, input.topology.compiledSpec);

      if (topologyChanged) {
        await transaction.rangeTemplateVersion.update({
          where: { id: template.currentDraftVersion.id },
          data: {
            topologySpec: input.topology.topologySpec as Prisma.InputJsonValue,
            topologyGraph: input.topology.topologyGraph as Prisma.InputJsonValue,
            scenarioTemplateSpec: input.topology.scenarioTemplateSpec as Prisma.InputJsonValue,
            compiledProvisionSpec: input.topology.compiledProvisionSpec as Prisma.InputJsonValue,
            compiledSpec: input.topology.compiledSpec as Prisma.InputJsonValue,
          },
        });

        const updatedTemplate = await transaction.rangeTemplate.updateMany({
          where: {
            id: template.id,
            revision: input.expectedTemplateRevision,
          },
          data: {
            topologySpec: input.topology.topologySpec as Prisma.InputJsonValue,
            topologyGraph: input.topology.topologyGraph as Prisma.InputJsonValue,
            scenarioTemplateSpec: input.topology.scenarioTemplateSpec as Prisma.InputJsonValue,
            compiledProvisionSpec: input.topology.compiledProvisionSpec as Prisma.InputJsonValue,
            compiledSpec: input.topology.compiledSpec as Prisma.InputJsonValue,
            revision: { increment: 1 },
          },
        });

        if (updatedTemplate.count !== 1) {
          throw new TemplateRevisionConflictError();
        }
      }

      return transaction.rangeTemplate.findUniqueOrThrow({
        where: { id: template.id },
        include: {
          currentDraftVersion: true,
          currentPublishedVersion: true,
          versions: true,
        },
      }) as Promise<RangeTemplateRecord>;
    });
  }

  async publishRangeTemplateToPlatform(id: string, expectedRevision: number): Promise<RangeTemplateRecord> {
    return this.prisma.$transaction(async (tx) => {
      const template = await tx.rangeTemplate.findUniqueOrThrow({
        where: { id },
        include: {
          currentDraftVersion: true,
          currentPublishedVersion: true,
        },
      });

      if (template.revision !== expectedRevision) {
        throw new TemplateRevisionConflictError();
      }

      if (template.currentPublishedVersion && template.visibility === 'platform') {
        return tx.rangeTemplate.findUniqueOrThrow({
          where: { id },
          include: {
            currentDraftVersion: true,
            currentPublishedVersion: true,
            versions: true,
          },
        }) as Promise<RangeTemplateRecord>;
      }

      if (!template.currentDraftVersion) {
        throw new Error('Current editable template snapshot not found');
      }

      let publishedVersionId = template.currentPublishedVersionId;
      let currentDraftVersionId = template.currentDraftVersionId;

      if (!template.currentPublishedVersion) {
        await tx.rangeTemplateVersion.updateMany({
          where: {
            templateId: id,
            status: 'published',
          },
          data: { status: 'archived' },
        });

        const publishedVersion = await tx.rangeTemplateVersion.update({
          where: { id: template.currentDraftVersion.id },
          data: { status: 'published' },
        });
        const nextDraft = await tx.rangeTemplateVersion.create({
          data: {
            templateId: template.id,
            version: publishedVersion.version,
            status: 'draft',
            modulePathOrRef: publishedVersion.modulePathOrRef,
            topologySpec: publishedVersion.topologySpec as Prisma.InputJsonValue,
            topologyGraph: publishedVersion.topologyGraph as
              | Prisma.InputJsonValue
              | Prisma.NullableJsonNullValueInput,
            scenarioTemplateSpec: publishedVersion.scenarioTemplateSpec as
              | Prisma.InputJsonValue
              | Prisma.NullableJsonNullValueInput,
            compiledProvisionSpec: publishedVersion.compiledProvisionSpec as
              | Prisma.InputJsonValue
              | Prisma.NullableJsonNullValueInput,
            compiledSpec: publishedVersion.compiledSpec as
              | Prisma.InputJsonValue
              | Prisma.NullableJsonNullValueInput,
            variableSchema: publishedVersion.variableSchema as Prisma.InputJsonValue,
            outputSchema: publishedVersion.outputSchema as Prisma.InputJsonValue,
            defaultNetworkPolicy: publishedVersion.defaultNetworkPolicy as
              | Prisma.InputJsonValue
              | Prisma.NullableJsonNullValueInput,
          },
        });

        publishedVersionId = publishedVersion.id;
        currentDraftVersionId = nextDraft.id;
      }

      const updated = await tx.rangeTemplate.updateMany({
        where: {
          id,
          revision: expectedRevision,
        },
        data: {
          visibility: 'platform',
          currentPublishedVersionId: publishedVersionId,
          currentDraftVersionId,
          revision: { increment: 1 },
        },
      });

      if (updated.count !== 1) {
        throw new TemplateRevisionConflictError();
      }

      return tx.rangeTemplate.findUniqueOrThrow({
        where: { id },
        include: {
          currentDraftVersion: true,
          currentPublishedVersion: true,
          versions: true,
        },
      }) as Promise<RangeTemplateRecord>;
    });
  }

  async unshareRangeTemplate(id: string, expectedRevision: number): Promise<RangeTemplateRecord> {
    return this.prisma.$transaction(async (tx) => {
      const template = await tx.rangeTemplate.findUniqueOrThrow({ where: { id } });

      if (template.revision !== expectedRevision) {
        throw new TemplateRevisionConflictError();
      }

      if (template.visibility === 'private') {
        return tx.rangeTemplate.findUniqueOrThrow({
          where: { id },
          include: {
            currentDraftVersion: true,
            currentPublishedVersion: true,
            versions: true,
          },
        }) as Promise<RangeTemplateRecord>;
      }

      const updated = await tx.rangeTemplate.updateMany({
        where: {
          id,
          revision: expectedRevision,
        },
        data: {
          visibility: 'private',
          revision: { increment: 1 },
        },
      });

      if (updated.count !== 1) {
        throw new TemplateRevisionConflictError();
      }

      return tx.rangeTemplate.findUniqueOrThrow({
        where: { id },
        include: {
          currentDraftVersion: true,
          currentPublishedVersion: true,
          versions: true,
        },
      }) as Promise<RangeTemplateRecord>;
    });
  }

  async deleteRangeTemplate(id: string): Promise<void> {
    await this.prisma.rangeTemplate.delete({
      where: {
        id,
      },
    });
  }

  async createSingleInstanceBatch(input: CreateSingleInstanceBatchInput): Promise<SingleInstanceBatchRecord> {
    return this.prisma.singleInstanceBatch.create({
      data: {
        name: input.name,
        platformImageAssetId: input.platformImageAssetId,
        imageId: input.imageId,
        imageDisplayName: input.imageDisplayName,
        cpu: input.cpu,
        memory: input.memory,
        systemDiskSize: input.systemDiskSize,
        quantity: input.quantity,
        remark: input.remark ?? null,
        createdBy: input.createdBy ?? null,
        ownerUserId: input.ownerUserId ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    }) as Promise<SingleInstanceBatchRecord>;
  }

  async getSingleInstanceBatchById(id: string): Promise<SingleInstanceBatchRecord | null> {
    return this.prisma.singleInstanceBatch.findUnique({
      where: {
        id,
      },
    }) as Promise<SingleInstanceBatchRecord | null>;
  }

  async listSingleInstanceBatchesWithInstances(): Promise<SingleInstanceBatchWithInstancesRecord[]> {
    const batches = await this.prisma.singleInstanceBatch.findMany({
      include: {
        instances: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return batches.map((record) => ({
      batch: record as unknown as SingleInstanceBatchRecord,
      instances: record.instances as unknown as RangeInstanceRecord[],
    }));
  }

  async listRangeInstances(): Promise<RangeInstanceRecord[]> {
    return this.prisma.rangeInstance.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    }) as Promise<RangeInstanceRecord[]>;
  }

  async archiveDestroyedRangeInstancesForDeletedTemplate(template: RangeTemplateRecord): Promise<void> {
    await this.prisma.rangeInstance.updateMany({
      where: {
        templateId: template.id,
        status: 'destroyed',
      },
      data: {
        templateId: null,
        sourceTemplateVersionId: null,
        templateNameSnapshot: template.name,
        templateSlugSnapshot: template.slug,
        templateVersionSnapshot: template.version,
        templateModulePathSnapshot: template.modulePathOrRef,
      },
    });
  }

  async createRangeInstance(input: CreateRangeInstanceInput, initialJob?: { triggeredBy: string; topologySnapshot: ProvisionJobTopologySnapshot; expectedTemplateRevision?: number }): Promise<RangeInstanceRecord> {
    const data = {
        name: input.name,
        createdBy: input.createdBy ?? 'admin',
        ownerUserId: input.ownerUserId ?? null,
        templateId: input.templateId ?? null,
        sourceTemplateVersionId: input.sourceTemplateVersionId ?? null,
        templateNameSnapshot: input.templateNameSnapshot ?? null,
        templateSlugSnapshot: input.templateSlugSnapshot ?? null,
        templateVersionSnapshot: input.templateVersionSnapshot ?? null,
        templateModulePathSnapshot: input.templateModulePathSnapshot ?? null,
        runtimeTopologyGraph: (input.runtimeTopologyGraph ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        runtimeScenarioTemplateSpec: (input.runtimeScenarioTemplateSpec ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        runtimeCompiledProvisionSpec: (input.runtimeCompiledProvisionSpec ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        runtimeCredentials: (input.runtimeCredentials ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        draftTopologyGraph: (input.draftTopologyGraph ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        draftTopologySpec: (input.draftTopologySpec ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        draftScenarioTemplateSpec: (input.draftScenarioTemplateSpec ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        draftCompiledProvisionSpec: (input.draftCompiledProvisionSpec ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        draftRevision: input.draftRevision ?? 0,
        draftUpdatedBy: input.draftUpdatedBy ?? null,
        draftUpdatedAt: input.draftUpdatedAt ?? null,
        status: input.status ?? 'draft',
        instanceMode: input.instanceMode ?? 'range',
        singleInstanceBatchId: input.singleInstanceBatchId ?? null,
        singleInstanceConfig: (input.singleInstanceConfig ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        allocatedCidr: input.allocatedCidr ?? null,
        accessEntry: (input.accessEntry ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
        resourceSummary: (input.resourceSummary ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        errorSummary: input.errorSummary ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        lastJobId: input.lastJobId ?? null,
      };
    if (!initialJob) {
      return this.prisma.rangeInstance.create({ data }) as Promise<RangeInstanceRecord>;
    }
    return this.prisma.$transaction(async transaction => {
      if (initialJob.expectedTemplateRevision !== undefined && input.templateId) {
        const frozen = await transaction.rangeTemplate.updateMany({ where: { id: input.templateId, revision: initialJob.expectedTemplateRevision }, data: { revision: { increment: 0 } } });
        if (frozen.count !== 1) throw new TemplateRevisionConflictError();
      }
      const instance = await transaction.rangeInstance.create({ data });
      const job = await transaction.provisionJob.create({ data: {
        rangeInstanceId: instance.id, jobType: 'create', triggeredBy: initialJob.triggeredBy,
        topologySnapshot: initialJob.topologySnapshot as Prisma.InputJsonValue,
      } });
      return transaction.rangeInstance.update({ where: { id: instance.id }, data: { lastJobId: job.id } }) as Promise<RangeInstanceRecord>;
    });
  }

  async getRangeInstanceById(id: string): Promise<RangeInstanceRecord | null> {
    return this.prisma.rangeInstance.findUnique({
      where: {
        id,
      },
    }) as Promise<RangeInstanceRecord | null>;
  }

  async updateRangeInstance(id: string, input: UpdateRangeInstanceInput): Promise<RangeInstanceRecord> {
    return this.prisma.rangeInstance.update({ where: { id }, data: this.rangeInstanceUpdateData(input) }) as Promise<RangeInstanceRecord>;
  }

  private rangeInstanceUpdateData(input: UpdateRangeInstanceInput) {
    return {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
        ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.instanceMode !== undefined ? { instanceMode: input.instanceMode } : {}),
        ...(input.singleInstanceBatchId !== undefined
          ? { singleInstanceBatchId: input.singleInstanceBatchId }
          : {}),
        ...(input.singleInstanceConfig !== undefined
          ? {
              singleInstanceConfig: input.singleInstanceConfig as
                | Prisma.InputJsonValue
                | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.sourceTemplateVersionId !== undefined
          ? { sourceTemplateVersionId: input.sourceTemplateVersionId }
          : {}),
        ...(input.runtimeTopologyGraph !== undefined
          ? {
              runtimeTopologyGraph: input.runtimeTopologyGraph as
                | Prisma.InputJsonValue
                | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.runtimeScenarioTemplateSpec !== undefined
          ? {
              runtimeScenarioTemplateSpec: input.runtimeScenarioTemplateSpec as
                | Prisma.InputJsonValue
                | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.runtimeCompiledProvisionSpec !== undefined
          ? {
              runtimeCompiledProvisionSpec: input.runtimeCompiledProvisionSpec as
                | Prisma.InputJsonValue
                | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.runtimeCredentials !== undefined
          ? {
              runtimeCredentials: input.runtimeCredentials as
                | Prisma.InputJsonValue
                | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.draftTopologyGraph !== undefined
          ? {
              draftTopologyGraph: input.draftTopologyGraph as
                | Prisma.InputJsonValue
                | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.draftTopologySpec !== undefined
          ? {
              draftTopologySpec: input.draftTopologySpec as
                | Prisma.InputJsonValue
                | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.draftScenarioTemplateSpec !== undefined
          ? {
              draftScenarioTemplateSpec: input.draftScenarioTemplateSpec as
                | Prisma.InputJsonValue
                | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.draftCompiledProvisionSpec !== undefined
          ? {
              draftCompiledProvisionSpec: input.draftCompiledProvisionSpec as
                | Prisma.InputJsonValue
                | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
        ...(input.draftUpdatedBy !== undefined ? { draftUpdatedBy: input.draftUpdatedBy } : {}),
        ...(input.draftUpdatedAt !== undefined ? { draftUpdatedAt: input.draftUpdatedAt } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.allocatedCidr !== undefined ? { allocatedCidr: input.allocatedCidr } : {}),
        ...(input.accessEntry !== undefined
          ? {
              accessEntry: input.accessEntry as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.resourceSummary !== undefined
          ? {
              resourceSummary: input.resourceSummary as
                | Prisma.InputJsonValue
                | Prisma.NullableJsonNullValueInput,
            }
          : {}),
        ...(input.errorSummary !== undefined ? { errorSummary: input.errorSummary } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.lastJobId !== undefined ? { lastJobId: input.lastJobId } : {}),
      };
  }

  async saveRangeInstanceDraft(
    id: string,
    expectedDraftRevision: number,
    input: SaveRangeInstanceDraftInput,
  ): Promise<RangeInstanceRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.rangeInstance.updateMany({
        where: {
          id,
          status: 'running',
          draftRevision: expectedDraftRevision,
        },
        data: {
          draftTopologyGraph: input.draftTopologyGraph as Prisma.InputJsonValue,
          draftTopologySpec: input.draftTopologySpec as Prisma.InputJsonValue,
          draftScenarioTemplateSpec: input.draftScenarioTemplateSpec as Prisma.InputJsonValue,
          draftCompiledProvisionSpec: input.draftCompiledProvisionSpec as Prisma.InputJsonValue,
          draftUpdatedBy: input.draftUpdatedBy,
          draftUpdatedAt: input.draftUpdatedAt,
          draftRevision: {
            increment: 1,
          },
        },
      });

      return result.count === 0
        ? null
        : transaction.rangeInstance.findUnique({ where: { id } }) as Promise<RangeInstanceRecord | null>;
    });
  }

  async discardRangeInstanceDraft(id: string, expectedDraftRevision: number): Promise<RangeInstanceRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.rangeInstance.updateMany({
        where: {
          id,
          status: 'running',
          draftRevision: expectedDraftRevision,
        },
        data: {
          draftTopologyGraph: Prisma.DbNull,
          draftTopologySpec: Prisma.DbNull,
          draftScenarioTemplateSpec: Prisma.DbNull,
          draftCompiledProvisionSpec: Prisma.DbNull,
          draftUpdatedBy: null,
          draftUpdatedAt: null,
          draftRevision: {
            increment: 1,
          },
        },
      });

      return result.count === 0
        ? null
        : transaction.rangeInstance.findUnique({ where: { id } }) as Promise<RangeInstanceRecord | null>;
    });
  }

  async applyRangeInstanceDraft(input: ApplyRangeInstanceDraftInput): Promise<ProvisionJobRecord | null> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.rangeInstance.updateMany({ where: { id: input.rangeInstanceId }, data: { draftRevision: { increment: 0 } } });
        const instance = await transaction.rangeInstance.findUnique({
          where: { id: input.rangeInstanceId },
        });

        if (
          !instance ||
          instance.status !== 'running' ||
          instance.draftRevision !== input.expectedDraftRevision ||
          !instance.draftTopologyGraph ||
          !instance.draftTopologySpec ||
          !instance.draftScenarioTemplateSpec ||
          !instance.draftCompiledProvisionSpec
        ) {
          return null;
        }

        const job = await transaction.provisionJob.create({
          data: {
            rangeInstanceId: input.rangeInstanceId,
            jobType: 'update',
            triggeredBy: input.triggeredBy,
            topologySnapshot: input.topologySnapshot as Prisma.InputJsonValue,
          },
        });
        const updated = await transaction.rangeInstance.updateMany({
          where: {
            id: input.rangeInstanceId,
            status: 'running',
            draftRevision: input.expectedDraftRevision,
            jobs: {
              none: {
                id: {
                  not: job.id,
                },
                status: {
                  in: ['pending', 'running'],
                },
              },
            },
          },
          data: {
            lastJobId: job.id,
            errorSummary: null,
          },
        });

        if (updated.count !== 1) {
          throw new RangeInstanceDraftRevisionConflictError();
        }

        return job as ProvisionJobRecord;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (isSerializableTransactionConflict(error)) {
        throw new RangeInstanceDraftRevisionConflictError();
      }

      throw error;
    }
  }

  async completeRangeInstanceDraftApply(
    id: string,
    input: CompleteRangeInstanceDraftApplyInput,
  ): Promise<RangeInstanceRecord> {
    return this.prisma.$transaction(async (transaction) => {
      if (input.provisionJobId && input.claimStartedAt) {
        const owned = await this.lockRangeClaim(transaction, input.provisionJobId, input.claimStartedAt);
        if (!owned || owned.rangeInstanceId !== id) {
          throw new RangeInstanceDraftRevisionConflictError();
        }
      }
      const runtimeData = {
        runtimeTopologyGraph: input.runtimeTopologyGraph as Prisma.InputJsonValue,
        runtimeScenarioTemplateSpec: input.runtimeScenarioTemplateSpec as Prisma.InputJsonValue,
        runtimeCompiledProvisionSpec: input.runtimeCompiledProvisionSpec as Prisma.InputJsonValue,
        ...(input.runtimeCredentials !== undefined ? { runtimeCredentials: input.runtimeCredentials as Prisma.InputJsonValue } : {}),
        accessEntry: (input.accessEntry ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
        resourceSummary: (input.resourceSummary ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
        errorSummary: input.errorSummary ?? null,
      };
      const cleared = await transaction.rangeInstance.updateMany({
        where: {
          id,
          draftRevision: input.expectedDraftRevision,
        },
        data: {
          ...runtimeData,
          draftTopologyGraph: Prisma.DbNull,
          draftTopologySpec: Prisma.DbNull,
          draftScenarioTemplateSpec: Prisma.DbNull,
          draftCompiledProvisionSpec: Prisma.DbNull,
          draftUpdatedBy: null,
          draftUpdatedAt: null,
          draftRevision: {
            increment: 1,
          },
        },
      });

      if (cleared.count === 1) {
        return transaction.rangeInstance.findUniqueOrThrow({
          where: { id },
        }) as Promise<RangeInstanceRecord>;
      }

      return transaction.rangeInstance.update({
        where: { id },
        data: runtimeData,
      }) as Promise<RangeInstanceRecord>;
    });
  }

  async listProvisionJobs(): Promise<ProvisionJobRecord[]> {
    return this.prisma.provisionJob.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    }) as Promise<ProvisionJobRecord[]>;
  }

  async queueRangeInstanceJob(input: QueueRangeInstanceJobInput): Promise<ProvisionJobRecord | null> {
    return this.prisma.$transaction(async transaction => {
      const locked = await transaction.rangeInstance.updateMany({
        where: { id: input.rangeInstanceId, instanceMode: 'range', status: input.expectedStatus, ownerUserId: input.expectedOwnerUserId },
        data: { draftRevision: { increment: 0 } },
      });
      if (locked.count !== 1 || await transaction.provisionJob.count({ where: {
        rangeInstanceId: input.rangeInstanceId, status: { in: ['pending', 'running'] },
      } }) > 0) {
        return null;
      }
      const job = await transaction.provisionJob.create({ data: {
        rangeInstanceId: input.rangeInstanceId, jobType: input.jobType, triggeredBy: input.triggeredBy,
        retryCount: input.retryCount ?? 0,
        topologySnapshot: (input.topologySnapshot ?? Prisma.DbNull) as Prisma.InputJsonValue,
      } });
      await transaction.rangeInstance.update({ where: { id: input.rangeInstanceId }, data: {
        status: input.nextStatus, lastJobId: job.id, errorSummary: null,
        ...(input.allocatedCidr !== undefined ? { allocatedCidr: input.allocatedCidr } : {}),
      } });
      return job as ProvisionJobRecord;
    });
  }

  async claimRangeProvisionJob(id: string, startedAt: Date): Promise<ProvisionJobRecord | null> {
    return this.prisma.$transaction(async transaction => {
      const candidate = await transaction.provisionJob.findUnique({ where: { id } });
      if (!candidate || candidate.status !== 'pending') return null;
      await transaction.rangeInstance.updateMany({ where: { id: candidate.rangeInstanceId, instanceMode: 'range' }, data: { draftRevision: { increment: 0 } } });
      const instance = await transaction.rangeInstance.findUnique({ where: { id: candidate.rangeInstanceId } });
      if (!instance || instance.instanceMode !== 'range') return null;
      if (instance.lastJobId && instance.lastJobId !== id) {
        await transaction.provisionJob.updateMany({ where: { id, status: 'pending' }, data: {
          status: 'cancelled', finishedAt: startedAt, errorSummary: 'Superseded by the current range operation',
        } });
        return null;
      }
      if (candidate.jobType === 'update' && instance.status !== 'running'
        || (candidate.jobType === 'create' || candidate.topologySnapshot && (candidate.topologySnapshot as Record<string, unknown>).operation === 'create')
          && ['pending_destroy', 'destroying', 'destroy_failed', 'destroyed'].includes(instance.status)) {
        await transaction.provisionJob.updateMany({ where: { id, status: 'pending' }, data: {
          status: 'cancelled', finishedAt: startedAt, errorSummary: 'Range operation is incompatible with the current instance state',
        } });
        return null;
      }
      if (instance.lastJobId === id) {
        await transaction.provisionJob.updateMany({ where: {
          rangeInstanceId: instance.id, id: { not: id }, status: 'pending',
        }, data: { status: 'cancelled', finishedAt: startedAt, errorSummary: 'Superseded by the current range operation' } });
      }
      const otherActive = await transaction.provisionJob.count({ where: {
        rangeInstanceId: instance.id, id: { not: id }, status: { in: ['pending', 'running'] },
      } });
      if (otherActive > 0) return null;
      const claimed = await transaction.provisionJob.updateMany({ where: { id, status: 'pending' }, data: {
        status: 'running', startedAt, finishedAt: null, errorSummary: null,
      } });
      if (claimed.count !== 1) return null;
      if (!instance.lastJobId) {
        await transaction.rangeInstance.update({ where: { id: instance.id }, data: { lastJobId: id } });
      }
      return transaction.provisionJob.findUnique({ where: { id } }) as Promise<ProvisionJobRecord>;
    });
  }

  async heartbeatRangeProvisionJob(id: string, startedAt: Date, heartbeatAt: Date): Promise<boolean> {
    const changed = await this.prisma.provisionJob.updateMany({ where: {
      id, status: 'running', startedAt, rangeInstance: { instanceMode: 'range', lastJobId: id },
    }, data: { updatedAt: heartbeatAt } });
    return changed.count === 1;
  }

  private async lockRangeClaim(transaction: Prisma.TransactionClient, id: string, startedAt: Date) {
    const job = await transaction.provisionJob.findUnique({ where: { id } });
    if (!job) return null;
    const locked = await transaction.rangeInstance.updateMany({ where: {
      id: job.rangeInstanceId, instanceMode: 'range', lastJobId: id,
    }, data: { draftRevision: { increment: 0 } } });
    if (locked.count !== 1) return null;
    const owned = await transaction.provisionJob.updateMany({ where: { id, startedAt, status: 'running' }, data: { updatedAt: new Date() } });
    return owned.count === 1 ? job : null;
  }

  async updateRangeInstanceForProvisionJob(id: string, startedAt: Date, input: UpdateRangeInstanceInput): Promise<RangeInstanceRecord | null> {
    return this.prisma.$transaction(async transaction => {
      const job = await this.lockRangeClaim(transaction, id, startedAt);
      if (!job) return null;
      return transaction.rangeInstance.update({ where: { id: job.rangeInstanceId }, data: this.rangeInstanceUpdateData(input) }) as Promise<RangeInstanceRecord>;
    });
  }

  async updateRangeProvisionJob(id: string, startedAt: Date, input: UpdateProvisionJobInput): Promise<boolean> {
    const changed = await this.prisma.provisionJob.updateMany({ where: {
      id, status: 'running', startedAt, rangeInstance: { instanceMode: 'range', lastJobId: id },
    }, data: input });
    return changed.count === 1;
  }

  async createProvisionJob(input: CreateProvisionJobInput): Promise<ProvisionJobRecord> {
    return this.prisma.provisionJob.create({
      data: {
        rangeInstanceId: input.rangeInstanceId,
        jobType: input.jobType,
        triggeredBy: input.triggeredBy,
        topologySnapshot: (input.topologySnapshot ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        status: input.status ?? 'pending',
        retryCount: input.retryCount ?? 0,
      },
    }) as Promise<ProvisionJobRecord>;
  }

  async getProvisionJobById(id: string): Promise<ProvisionJobRecord | null> {
    return this.prisma.provisionJob.findUnique({
      where: {
        id,
      },
    }) as Promise<ProvisionJobRecord | null>;
  }

  async claimProvisionJob(id: string, startedAt: Date): Promise<ProvisionJobRecord | null> {
    const result = await this.prisma.provisionJob.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'running', startedAt, finishedAt: null, errorSummary: null },
    });

    if (result.count === 0) {
      return null;
    }

    return this.getProvisionJobById(id);
  }

  async heartbeatProvisionJob(id: string, startedAt: Date, heartbeatAt: Date): Promise<boolean> {
    const result = await this.prisma.provisionJob.updateMany({
      where: { id, status: 'running', startedAt },
      data: { updatedAt: heartbeatAt },
    });

    return result.count === 1;
  }

  async requeueInterruptedProvisionJobs(staleBefore: Date): Promise<number> {
    const result = await this.prisma.provisionJob.updateMany({
      where: {
        status: 'running',
        updatedAt: {
          lte: staleBefore,
        },
      },
      data: {
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        errorSummary: null,
        retryCount: {
          increment: 1,
        },
      },
    });

    return result.count;
  }

  async updateProvisionJob(id: string, input: UpdateProvisionJobInput): Promise<ProvisionJobRecord> {
    return this.prisma.provisionJob.update({
      where: {
        id,
      },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
        ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
        ...(input.errorSummary !== undefined ? { errorSummary: input.errorSummary } : {}),
      },
    }) as Promise<ProvisionJobRecord>;
  }

  async listProvisionJobStepLogs(jobId: string): Promise<ProvisionJobStepLogRecord[]> {
    return this.prisma.provisionJobStepLog.findMany({
      where: {
        jobId,
      },
      orderBy: {
        createdAt: 'asc',
      },
    }) as Promise<ProvisionJobStepLogRecord[]>;
  }

  async createProvisionJobStepLog(input: CreateProvisionJobStepLogInput): Promise<ProvisionJobStepLogRecord> {
    return this.prisma.provisionJobStepLog.create({
      data: {
        jobId: input.jobId,
        stepName: input.stepName,
        status: input.status ?? 'pending',
        message: input.message ?? null,
        stdoutExcerpt: input.stdoutExcerpt ?? null,
        stderrExcerpt: input.stderrExcerpt ?? null,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
      },
    }) as Promise<ProvisionJobStepLogRecord>;
  }

  async updateProvisionJobStepLog(
    id: string,
    input: UpdateProvisionJobStepLogInput,
  ): Promise<ProvisionJobStepLogRecord> {
    return this.prisma.provisionJobStepLog.update({
      where: {
        id,
      },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.stdoutExcerpt !== undefined ? { stdoutExcerpt: input.stdoutExcerpt } : {}),
        ...(input.stderrExcerpt !== undefined ? { stderrExcerpt: input.stderrExcerpt } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
      },
    }) as Promise<ProvisionJobStepLogRecord>;
  }

  async upsertCloudResourceDrift(input: UpsertCloudResourceDriftInput): Promise<CloudResourceDriftRecord> {
    const cloudProvider = input.cloudProvider ?? 'alibaba_cloud';
    const tagsSnapshot = input.tagsSnapshot ?? {};
    const record = await this.prisma.cloudResourceDrift.upsert({
      where: {
        cloudProvider_regionId_cloudResourceType_cloudResourceId: {
          cloudProvider,
          regionId: input.regionId,
          cloudResourceType: input.cloudResourceType,
          cloudResourceId: input.cloudResourceId,
        },
      },
      create: {
        cloudProvider,
        regionId: input.regionId,
        cloudResourceType: input.cloudResourceType,
        cloudResourceId: input.cloudResourceId,
        rangeInstanceId: input.rangeInstanceId ?? null,
        severity: input.severity,
        reason: input.reason,
        tagsSnapshot: tagsSnapshot as Prisma.InputJsonValue,
        firstSeenAt: input.observedAt,
        lastSeenAt: input.observedAt,
        resolvedAt: null,
      },
      update: {
        rangeInstanceId: input.rangeInstanceId ?? null,
        severity: input.severity,
        reason: input.reason,
        tagsSnapshot: tagsSnapshot as Prisma.InputJsonValue,
        lastSeenAt: input.observedAt,
        resolvedAt: null,
      },
    });

    return toCloudResourceDriftRecord(record);
  }

  async resolveCloudResourceDrift(input: {
    cloudProvider?: CloudProvider;
    regionId: string;
    cloudResourceType: string;
    cloudResourceId: string;
    resolvedAt: Date;
  }): Promise<void> {
    const cloudProvider = input.cloudProvider ?? 'alibaba_cloud';
    await this.prisma.cloudResourceDrift.updateMany({
      where: {
        cloudProvider,
        regionId: input.regionId,
        cloudResourceType: input.cloudResourceType,
        cloudResourceId: input.cloudResourceId,
        resolvedAt: null,
      },
      data: {
        resolvedAt: input.resolvedAt,
      },
    });
  }

  async listImageSnapshots(filter: ListImageSnapshotsFilter): Promise<CloudImageSnapshotRecord[]> {
    return this.prisma.cloudImageSnapshot.findMany({
      where: {
        ...(filter.provider !== undefined ? { provider: filter.provider } : {}),
        ...(filter.accountUid !== undefined ? { accountUid: filter.accountUid } : {}),
        ...(filter.regionId !== undefined ? { regionId: filter.regionId } : {}),
        ...(filter.scope !== undefined ? { scope: filter.scope } : {}),
        ...(filter.imageId !== undefined ? { imageId: filter.imageId } : {}),
      },
      orderBy: {
        createdAt: 'desc',
      },
    }) as Promise<CloudImageSnapshotRecord[]>;
  }

  async getImageSnapshotById(id: string): Promise<CloudImageSnapshotRecord | null> {
    return this.prisma.cloudImageSnapshot.findUnique({
      where: {
        id,
      },
    }) as Promise<CloudImageSnapshotRecord | null>;
  }

  async upsertImageSnapshots(input: UpsertImageSnapshotsInput): Promise<void> {
    for (const snapshot of input.snapshots) {
      await this.prisma.cloudImageSnapshot.upsert({
        where: {
          provider_accountScopeKey_regionId_scope_imageId: {
            provider: input.provider,
            accountScopeKey: toAccountScopeKey(input.accountUid),
            regionId: input.regionId,
            scope: input.scope,
            imageId: snapshot.imageId,
          },
        },
        update: {
          accountUid: input.accountUid,
          sourceImageName: snapshot.sourceImageName,
          osType: snapshot.osType ?? null,
          platform: snapshot.platform ?? null,
          architecture: snapshot.architecture ?? null,
          status: snapshot.status ?? null,
          isAvailable: snapshot.isAvailable ?? true,
          lastSyncedAt: snapshot.lastSyncedAt,
        },
        create: {
          provider: input.provider,
          accountUid: input.accountUid,
          accountScopeKey: toAccountScopeKey(input.accountUid),
          regionId: input.regionId,
          scope: input.scope,
          imageId: snapshot.imageId,
          sourceImageName: snapshot.sourceImageName,
          osType: snapshot.osType ?? null,
          platform: snapshot.platform ?? null,
          architecture: snapshot.architecture ?? null,
          status: snapshot.status ?? null,
          isAvailable: snapshot.isAvailable ?? true,
          lastSyncedAt: snapshot.lastSyncedAt,
        },
      });
    }
  }

  async reconcileImageSnapshots(input: ReconcileImageSnapshotsInput): Promise<void> {
    await this.upsertImageSnapshots(input);

    const imageIds = input.snapshots.map((snapshot) => snapshot.imageId);

    await this.prisma.cloudImageSnapshot.deleteMany({
      where: {
        provider: input.provider,
        accountScopeKey: toAccountScopeKey(input.accountUid),
        regionId: input.regionId,
        scope: input.scope,
        ...(imageIds.length > 0 ? { imageId: { notIn: imageIds } } : {}),
      },
    });
  }

  async listImageCatalogItems(filter: ListImageCatalogItemsFilter = {}): Promise<ImageCatalogItemRecord[]> {
    return this.prisma.imageCatalogItem.findMany({
      where: {
        ...(filter.provider !== undefined ? { provider: filter.provider } : {}),
        ...(filter.scope !== undefined ? { scope: filter.scope } : {}),
        ...(filter.accountUid !== undefined ? { accountUid: filter.accountUid } : {}),
        ...(filter.regionId !== undefined ? { regionId: filter.regionId } : {}),
        ...(filter.enabled !== undefined ? { enabled: filter.enabled } : {}),
      },
      orderBy: {
        createdAt: 'desc',
      },
    }) as Promise<ImageCatalogItemRecord[]>;
  }

  async collectImageCatalogItem(input: CollectImageCatalogItemInput): Promise<ImageCatalogItemRecord> {
    return this.prisma.imageCatalogItem.upsert({
      where: {
        provider_accountScopeKey_regionId_scope_imageId: {
          provider: input.provider,
          accountScopeKey: toAccountScopeKey(input.accountUid),
          regionId: input.regionId,
          scope: input.scope,
          imageId: input.imageId,
        },
      },
      update: {
        displayName: input.displayName,
        accountUid: input.accountUid,
        enabled: input.enabled ?? true,
        sourceSnapshotId: input.sourceSnapshotId ?? null,
      },
      create: {
        displayName: input.displayName,
        imageId: input.imageId,
        provider: input.provider,
        scope: input.scope,
        accountUid: input.accountUid,
        accountScopeKey: toAccountScopeKey(input.accountUid),
        regionId: input.regionId,
        enabled: input.enabled ?? true,
        sourceSnapshotId: input.sourceSnapshotId ?? null,
      },
    }) as Promise<ImageCatalogItemRecord>;
  }

  async listPlatformImageAssets(filter: ListPlatformImageAssetsFilter = {}): Promise<PlatformImageAssetRecord[]> {
    const assets = await this.prisma.platformImageAsset.findMany({
      where: {
        ...(filter.provider !== undefined ? { provider: filter.provider } : {}),
        ...(filter.accountUid !== undefined ? { accountUid: filter.accountUid } : {}),
        ...(filter.accountScopeKey !== undefined ? { accountScopeKey: filter.accountScopeKey } : {}),
        ...(filter.regionId !== undefined ? { regionId: filter.regionId } : {}),
        ...(filter.enabled !== undefined ? { enabled: filter.enabled } : {}),
        ...(filter.imageId !== undefined ? { imageId: filter.imageId } : {}),
        ...(filter.sourceSnapshotId !== undefined ? { sourceSnapshotId: filter.sourceSnapshotId } : {}),
        ...(filter.ownerUserId !== undefined ? { ownerUserId: filter.ownerUserId } : {}),
        ...(filter.visibility !== undefined ? { visibility: filter.visibility } : {}),
        ...(filter.onlyAvailableSourceSnapshots
          ? {
              OR: [
                { sourceSnapshotId: null },
                { sourceSnapshot: { is: { isAvailable: true } } },
              ],
            }
          : {}),
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: platformImageAssetTagInclude,
    });

    return assets.map((asset) => toPlatformImageAssetRecord(asset as PlatformImageAssetWithTags));
  }

  async getPlatformImageAssetById(id: string): Promise<PlatformImageAssetRecord | null> {
    const asset = await this.prisma.platformImageAsset.findUnique({
      where: {
        id,
      },
      include: platformImageAssetTagInclude,
    });

    return asset ? toPlatformImageAssetRecord(asset as PlatformImageAssetWithTags) : null;
  }

  async collectPlatformImageAsset(input: CollectPlatformImageAssetInput): Promise<PlatformImageAssetRecord> {
    const snapshot = await this.prisma.cloudImageSnapshot.findUniqueOrThrow({
      where: {
        id: input.snapshotId,
      },
    });

    const asset = await this.prisma.platformImageAsset.upsert({
      where: {
        provider_accountScopeKey_regionId_imageId: {
          provider: snapshot.provider,
          accountScopeKey: snapshot.accountScopeKey,
          regionId: snapshot.regionId,
          imageId: snapshot.imageId,
        },
      },
      update: {
        displayName: input.displayName,
        defaultHostName: input.defaultHostName ?? null,
        defaultPassword: input.defaultPassword ?? null,
        description: input.description ?? null,
        enabled: true,
        sourceScope: snapshot.scope,
        sourceSnapshotId: snapshot.id,
        accountUid: snapshot.accountUid,
        ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      },
      create: {
        provider: snapshot.provider,
        accountUid: snapshot.accountUid,
        accountScopeKey: snapshot.accountScopeKey,
        regionId: snapshot.regionId,
        sourceScope: snapshot.scope,
        sourceSnapshotId: snapshot.id,
        imageId: snapshot.imageId,
        displayName: input.displayName,
        defaultHostName: input.defaultHostName ?? null,
        defaultPassword: input.defaultPassword ?? null,
        description: input.description ?? null,
        ownerUserId: input.ownerUserId ?? null,
        visibility: input.visibility ?? 'private',
        enabled: true,
      },
      include: platformImageAssetTagInclude,
    });

    return toPlatformImageAssetRecord(asset as PlatformImageAssetWithTags);
  }

  async updatePlatformImageAsset(id: string, input: { displayName: string }): Promise<PlatformImageAssetRecord> {
    const asset = await this.prisma.platformImageAsset.update({
      where: {
        id,
      },
      data: {
        displayName: input.displayName,
      },
      include: platformImageAssetTagInclude,
    });

    return toPlatformImageAssetRecord(asset as PlatformImageAssetWithTags);
  }

  async setPlatformImageAssetEnabled(id: string, enabled: boolean): Promise<PlatformImageAssetRecord> {
    const asset = await this.prisma.platformImageAsset.update({
      where: {
        id,
      },
      data: {
        enabled,
      },
      include: platformImageAssetTagInclude,
    });

    return toPlatformImageAssetRecord(asset as PlatformImageAssetWithTags);
  }

  async listPlatformImageTags(): Promise<PlatformImageTagRecord[]> {
    return this.prisma.platformImageTag.findMany({
      orderBy: {
        name: 'asc',
      },
    }) as Promise<PlatformImageTagRecord[]>;
  }

  async listPlatformImageTagsByIds(ids: string[]): Promise<PlatformImageTagRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    return this.prisma.platformImageTag.findMany({
      where: {
        id: {
          in: ids,
        },
      },
    }) as Promise<PlatformImageTagRecord[]>;
  }

  async createPlatformImageTag(input: CreatePlatformImageTagInput): Promise<PlatformImageTagRecord> {
    return this.prisma.platformImageTag.create({
      data: input,
    }) as Promise<PlatformImageTagRecord>;
  }

  async replacePlatformImageAssetTags(id: string, tagIds: string[]): Promise<PlatformImageAssetRecord> {
    const asset = await this.prisma.platformImageAsset.update({
      where: {
        id,
      },
      data: {
        tags: {
          deleteMany: {},
          create: tagIds.map((tagId) => ({
            tag: {
              connect: {
                id: tagId,
              },
            },
          })),
        },
      },
      include: platformImageAssetTagInclude,
    });

    return toPlatformImageAssetRecord(asset as PlatformImageAssetWithTags);
  }

  async hasActiveImageImportForArtifact(input: {
    platformImageAssetId?: string | null;
    sourceSnapshotId?: string | null;
    imageId?: string | null;
  }): Promise<boolean> {
    const references = [
      input.platformImageAssetId ? { platformImageAssetId: input.platformImageAssetId } : null,
      input.sourceSnapshotId ? { sourceSnapshotId: input.sourceSnapshotId } : null,
      input.imageId ? { imageId: input.imageId } : null,
    ].filter(
      (value): value is { platformImageAssetId: string } | { sourceSnapshotId: string } | { imageId: string } =>
        value !== null,
    );

    if (references.length === 0) {
      return false;
    }

    return (
      (await this.prisma.imageImportJob.count({
        where: {
          status: 'importing',
          OR: references,
        },
      })) > 0
    );
  }

  async deletePlatformImageAsset(id: string): Promise<void> {
    await this.prisma.platformImageAsset.delete({
      where: {
        id,
      },
    });
  }

  async deletePlatformImageAssetsBySnapshotId(snapshotId: string): Promise<void> {
    await this.prisma.platformImageAsset.deleteMany({
      where: {
        sourceSnapshotId: snapshotId,
      },
    });
  }

  async withSingleInstanceControlLock<T>(work: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize native job intake/network lifecycle across API processes, not cloud execution.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(714921, 1)`;
      return work();
    }, { timeout: 15 * 60_000, maxWait: 30_000 });
  }

  async commitSingleInstanceClaim(job: ProvisionJobRecord, instancePatch: UpdateRangeInstanceInput, jobPatch?: UpdateProvisionJobInput) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "ProvisionJob" WHERE id = ${job.id} FOR UPDATE`;
      await tx.$executeRaw`SELECT id FROM "RangeInstance" WHERE id = ${job.rangeInstanceId} FOR UPDATE`;
      const currentJob = await tx.provisionJob.findUnique({ where: { id: job.id } });
      const instance = await tx.rangeInstance.findUnique({ where: { id: job.rangeInstanceId } });
      if (!job.startedAt || currentJob?.status !== 'running'
        || currentJob.startedAt?.getTime() !== job.startedAt.getTime()
        || instance?.lastJobId !== job.id || instance.instanceMode !== 'single' || ['destroyed','create_failed'].includes(instance.status)) return false;
      const jsonFields = new Set(['accessEntry', 'resourceSummary', 'singleInstanceConfig', 'runtimeTopologyGraph', 'runtimeScenarioTemplateSpec', 'runtimeCompiledProvisionSpec']);
      const data = Object.fromEntries(Object.entries(instancePatch).map(([key, value]) => [key, jsonFields.has(key) && value === null ? Prisma.DbNull : value]));
      await tx.rangeInstance.update({ where: { id: instance.id }, data: data as Prisma.RangeInstanceUncheckedUpdateInput });
      if (jobPatch) await tx.provisionJob.update({ where: { id: job.id }, data: jobPatch });
      return true;
    });
  }

  async listSingleInstanceNetworkProfiles() {
    return this.prisma.singleInstanceNetworkProfile.findMany() as unknown as Promise<import('../admin/admin.repository').SingleInstanceNetworkProfileRecord[]>;
  }
  async getSingleInstanceNetworkProfileById(id: string) {
    return this.prisma.singleInstanceNetworkProfile.findUnique({ where: { id } }) as unknown as Promise<import('../admin/admin.repository').SingleInstanceNetworkProfileRecord | null>;
  }
  async registerSingleInstanceNetworkCleanup(id:string,runId:string,adminId:string,ownerIds:string[]) {
    await this.prisma.singleInstanceNetworkProfile.update({where:{id},data:{cleanupRunId:runId,cleanupRegisteredByUserId:adminId,cleanupOwnerUserIds:ownerIds}});
  }
  async markSingleInstanceNetworkDestroying(id: string) {
    await this.prisma.singleInstanceNetworkProfile.update({where:{id},data:{status:'destroying'}});
  }
  async deleteSingleInstanceNetworkProfile(id: string) {
    await this.prisma.singleInstanceNetworkProfile.delete({ where: { id } });
  }

  async getSingleInstanceNetworkProfile(input: {
    cloudAccountUid?: string;
    provider: 'alibaba_cloud';
    regionId: string;
    zoneId: string;
  }) {
    return this.prisma.singleInstanceNetworkProfile.findUnique({
      where: {
        provider_cloudAccountUid_regionId_zoneId: {
          provider: input.provider,
          cloudAccountUid: input.cloudAccountUid ?? 'legacy-unbound',
          regionId: input.regionId,
          zoneId: input.zoneId,
        },
      },
    }) as Promise<import('../admin/admin.repository').SingleInstanceNetworkProfileRecord | null>;
  }

  async upsertSingleInstanceNetworkProfile(input: import('../admin/admin.repository').UpsertSingleInstanceNetworkProfileInput) {
    return this.prisma.singleInstanceNetworkProfile.upsert({
      where: {
        provider_cloudAccountUid_regionId_zoneId: {
          cloudAccountUid: input.cloudAccountUid ?? 'legacy-unbound',
          provider: input.provider,
          regionId: input.regionId,
          zoneId: input.zoneId,
        },
      },
      update: {
        status:input.status,
        cloudAccountContextId: input.cloudAccountContextId,
        workspaceKey: input.workspaceKey,
        managedByPlatform: input.managedByPlatform,
        vpcId: input.vpcId,
        vpcCidr: input.vpcCidr,
        vswitchIds: input.vswitchIds as Prisma.InputJsonValue,
        vswitchCidrs: input.vswitchCidrs as Prisma.InputJsonValue,
        securityGroupId: input.securityGroupId,
        securityGroupName: input.securityGroupName,
      },
      create: {
        createdByUserId:input.createdByUserId,
        status:input.status??'ready',
        cloudAccountUid: input.cloudAccountUid ?? 'legacy-unbound',
        cloudAccountContextId: input.cloudAccountContextId ?? null,
        workspaceKey: input.workspaceKey ?? null,
        managedByPlatform: input.managedByPlatform ?? false,
        provider: input.provider,
        regionId: input.regionId,
        zoneId: input.zoneId,
        vpcId: input.vpcId,
        vpcCidr: input.vpcCidr,
        vswitchIds: input.vswitchIds as Prisma.InputJsonValue,
        vswitchCidrs: input.vswitchCidrs as Prisma.InputJsonValue,
        securityGroupId: input.securityGroupId,
        securityGroupName: input.securityGroupName,
      },
    }) as Promise<import('../admin/admin.repository').SingleInstanceNetworkProfileRecord>;
  }

  async createBillingLedgerResource(input: CreateBillingLedgerResourceInput): Promise<BillingLedgerResourceRecord> {
    return this.prisma.billingLedgerResource.create({
      data: {
        cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
        cloudAccountUid: input.cloudAccountUid ?? null,
        regionId: input.regionId,
        cloudResourceId: input.cloudResourceId,
        cloudResourceType: input.cloudResourceType,
        billingScope: input.billingScope,
        ownerUserId: input.ownerUserId ?? null,
        rangeInstanceId: input.rangeInstanceId ?? null,
        singleInstanceBatchId: input.singleInstanceBatchId ?? null,
        platformImageAssetId: input.platformImageAssetId ?? null,
        sourceProvisionJobId: input.sourceProvisionJobId ?? null,
        billingStartAt: input.billingStartAt,
        releasedAt: input.releasedAt ?? null,
        tagsSnapshot: (input.tagsSnapshot ?? {}) as Prisma.InputJsonValue,
      },
    }) as Promise<BillingLedgerResourceRecord>;
  }

  async findBillingLedgerResource(input: FindBillingLedgerResourceInput): Promise<BillingLedgerResourceRecord | null> {
    return this.prisma.billingLedgerResource.findUnique({
      where: {
        cloudProvider_regionId_cloudResourceId_cloudResourceType: {
          cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
          regionId: input.regionId,
          cloudResourceId: input.cloudResourceId,
          cloudResourceType: input.cloudResourceType,
        },
      },
    }) as Promise<BillingLedgerResourceRecord | null>;
  }

  async updateBillingLedgerResource(id: string, input: UpdateBillingLedgerResourceInput): Promise<BillingLedgerResourceRecord> {
    return this.prisma.billingLedgerResource.update({
      where: { id },
      data: {
        ...(input.cloudAccountUid !== undefined ? { cloudAccountUid: input.cloudAccountUid } : {}),
        ...(input.billingScope !== undefined ? { billingScope: input.billingScope } : {}),
        ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.rangeInstanceId !== undefined ? { rangeInstanceId: input.rangeInstanceId } : {}),
        ...(input.singleInstanceBatchId !== undefined ? { singleInstanceBatchId: input.singleInstanceBatchId } : {}),
        ...(input.platformImageAssetId !== undefined ? { platformImageAssetId: input.platformImageAssetId } : {}),
        ...(input.sourceProvisionJobId !== undefined ? { sourceProvisionJobId: input.sourceProvisionJobId } : {}),
        ...(input.billingStartAt !== undefined ? { billingStartAt: input.billingStartAt } : {}),
        ...(input.releasedAt !== undefined ? { releasedAt: input.releasedAt } : {}),
        ...(input.tagsSnapshot !== undefined ? { tagsSnapshot: input.tagsSnapshot as Prisma.InputJsonValue } : {}),
      },
    }) as Promise<BillingLedgerResourceRecord>;
  }

  async listBillingLedgerResources(): Promise<BillingLedgerResourceRecord[]> {
    return this.prisma.billingLedgerResource.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    }) as Promise<BillingLedgerResourceRecord[]>;
  }

  async getLatestBillingLineItemDate(cloudAccountUid?: string): Promise<Date | null> {
    const result = await this.prisma.billingLineItem.aggregate({
      ...(cloudAccountUid !== undefined ? { where: { cloudAccountUid } } : {}),
      _max: {
        billingDate: true,
      },
    });

    return result._max.billingDate;
  }

  async replaceBillingDay(input: { cloudAccountUid: string; billingDate: string; lineItems: CreateBillingLineItemInput[]; anomalies: CreateBillingAnomalyInput[] }): Promise<void> {
    const billingDate = new Date(`${input.billingDate}T00:00:00.000Z`);
    const records = [...input.lineItems, ...input.anomalies];
    if (!input.cloudAccountUid || records.some(item => item.cloudAccountUid !== input.cloudAccountUid || new Date(item.billingDate).getTime() !== billingDate.getTime())) {
      throw new Error('Billing replacement account or date mismatch');
    }
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${input.cloudAccountUid}:${input.billingDate}`}, 0))`;
      await tx.$executeRaw`UPDATE "BillingLineItem" b SET "cloudAccountUid" = ${input.cloudAccountUid}
        FROM "BillingLedgerResource" l WHERE b."cloudAccountUid" IS NULL
        AND b."matchedLedgerId" = l."id" AND l."cloudAccountUid" = ${input.cloudAccountUid}
        AND b."billingDate" = ${billingDate}`;
      const where = { cloudAccountUid: input.cloudAccountUid, billingDate };
      await tx.billingLineItem.deleteMany({ where });
      await tx.billingAnomaly.deleteMany({ where });
      if (input.lineItems.length) {
        await tx.billingLineItem.createMany({ data: input.lineItems.map(item => ({ ...item, billingDate, pretaxAmount: new Prisma.Decimal(item.pretaxAmount), rawPayload: (item.rawPayload ?? {}) as Prisma.InputJsonValue })) });
      }
      if (input.anomalies.length) {
        await tx.billingAnomaly.createMany({ data: input.anomalies.map(item => ({ ...item, billingDate, pretaxAmount: new Prisma.Decimal(item.pretaxAmount), rawPayload: (item.rawPayload ?? {}) as Prisma.InputJsonValue })) });
      }
    }, { timeout: 30_000 });
  }

  async deleteBillingLineItemsBySyncBatchId(syncBatchId: string): Promise<void> {
    await this.prisma.billingLineItem.deleteMany({
      where: {
        syncBatchId,
      },
    });
  }

  async upsertBillingLineItems(input: CreateBillingLineItemInput[]): Promise<BillingLineItemRecord[]> {
    const records = await this.prisma.$transaction(
      input.map((item) =>
        this.prisma.billingLineItem.upsert({
          where: {
            sourceFingerprint: item.sourceFingerprint,
          },
          update: {
            cloudAccountUid: item.cloudAccountUid ?? null,
            syncBatchId: item.syncBatchId,
            billCycle: item.billCycle,
            billingDate: item.billingDate instanceof Date ? item.billingDate : new Date(item.billingDate),
            productCode: item.productCode,
            productDetail: item.productDetail ?? null,
            billItem: item.billItem,
            cloudResourceId: item.cloudResourceId,
            cloudResourceType: item.cloudResourceType,
            pretaxAmount: new Prisma.Decimal(item.pretaxAmount),
            currency: item.currency,
            billingScope: item.billingScope,
            ownerUserId: item.ownerUserId ?? null,
            matchedLedgerId: item.matchedLedgerId ?? null,
            rawPayload: (item.rawPayload ?? {}) as Prisma.InputJsonValue,
          },
          create: {
            cloudAccountUid: item.cloudAccountUid ?? null,
            syncBatchId: item.syncBatchId,
            sourceFingerprint: item.sourceFingerprint,
            billCycle: item.billCycle,
            billingDate: item.billingDate instanceof Date ? item.billingDate : new Date(item.billingDate),
            productCode: item.productCode,
            productDetail: item.productDetail ?? null,
            billItem: item.billItem,
            cloudResourceId: item.cloudResourceId,
            cloudResourceType: item.cloudResourceType,
            pretaxAmount: new Prisma.Decimal(item.pretaxAmount),
            currency: item.currency,
            billingScope: item.billingScope,
            ownerUserId: item.ownerUserId ?? null,
            matchedLedgerId: item.matchedLedgerId ?? null,
            rawPayload: (item.rawPayload ?? {}) as Prisma.InputJsonValue,
          },
        }),
      ),
    );

    return records.map(toBillingLineItemRecord);
  }

  async listBillingLineItems(filter: ListBillingLineItemsFilter = {}): Promise<BillingLineItemRecord[]> {
    const startAt = filter.startAt
      ? filter.startAt instanceof Date
        ? filter.startAt
        : new Date(filter.startAt)
      : null;
    const endAt = filter.endAt ? (filter.endAt instanceof Date ? filter.endAt : new Date(filter.endAt)) : null;
    const where: Prisma.BillingLineItemWhereInput = {
      ...(filter.cloudAccountUid !== undefined ? { cloudAccountUid: filter.cloudAccountUid } : {}),
      ...(startAt || endAt
        ? {
            billingDate: {
              ...(startAt ? { gte: startAt } : {}),
              ...(endAt
                ? {
                    lt: new Date(
                      new Date(endAt).setUTCDate(new Date(endAt).getUTCDate() + 1),
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(filter.ownerUserId !== undefined ? { ownerUserId: filter.ownerUserId } : {}),
      ...(filter.billingScope !== undefined ? { billingScope: filter.billingScope } : {}),
      ...(filter.matchedLedgerId !== undefined ? { matchedLedgerId: filter.matchedLedgerId } : {}),
    };

    const records = await this.prisma.billingLineItem.findMany({
      where,
      orderBy: {
        billingDate: 'desc',
      },
    });

    return records.map(toBillingLineItemRecord);
  }

  async createBillingAnomaly(input: CreateBillingAnomalyInput): Promise<BillingAnomalyRecord> {
    const record = await this.prisma.billingAnomaly.upsert({
      where: {
        sourceFingerprint: input.sourceFingerprint,
      },
      update: {
        cloudAccountUid: input.cloudAccountUid ?? null,
        syncBatchId: input.syncBatchId,
        billCycle: input.billCycle,
        billingDate: input.billingDate instanceof Date ? input.billingDate : new Date(input.billingDate),
        cloudResourceId: input.cloudResourceId,
        cloudResourceType: input.cloudResourceType,
        pretaxAmount: new Prisma.Decimal(input.pretaxAmount),
        currency: input.currency,
        reason: input.reason,
        rawPayload: (input.rawPayload ?? {}) as Prisma.InputJsonValue,
      },
      create: {
        cloudAccountUid: input.cloudAccountUid ?? null,
        syncBatchId: input.syncBatchId,
        sourceFingerprint: input.sourceFingerprint,
        billCycle: input.billCycle,
        billingDate: input.billingDate instanceof Date ? input.billingDate : new Date(input.billingDate),
        cloudResourceId: input.cloudResourceId,
        cloudResourceType: input.cloudResourceType,
        pretaxAmount: new Prisma.Decimal(input.pretaxAmount),
        currency: input.currency,
        reason: input.reason,
        rawPayload: (input.rawPayload ?? {}) as Prisma.InputJsonValue,
      },
    });

    return toBillingAnomalyRecord(record);
  }

  async deleteBillingAnomaliesBySyncBatchId(syncBatchId: string): Promise<void> {
    await this.prisma.billingAnomaly.deleteMany({
      where: {
        syncBatchId,
      },
    });
  }

  async listBillingAnomalies(filter: ListBillingAnomaliesFilter = {}): Promise<BillingAnomalyRecord[]> {
    const startAt = filter.startAt
      ? filter.startAt instanceof Date
        ? filter.startAt
        : new Date(filter.startAt)
      : null;
    const endAt = filter.endAt ? (filter.endAt instanceof Date ? filter.endAt : new Date(filter.endAt)) : null;
    const records = await this.prisma.billingAnomaly.findMany({
      where: {
        ...(filter.cloudAccountUid !== undefined ? { cloudAccountUid: filter.cloudAccountUid } : {}),
        ...(startAt || endAt
          ? {
              billingDate: {
                ...(startAt ? { gte: startAt } : {}),
                ...(endAt
                  ? {
                      lt: new Date(
                        new Date(endAt).setUTCDate(new Date(endAt).getUTCDate() + 1),
                      ),
                    }
                  : {}),
              },
            }
          : {}),
      },
      orderBy: {
        billingDate: 'desc',
      },
    });

    return records.map(toBillingAnomalyRecord);
  }
}
