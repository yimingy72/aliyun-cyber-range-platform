import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../../packages/database/generated/client';
import {
  AdminRepository,
  CloudImageSnapshotRecord,
  CollectImageCatalogItemInput,
  CollectPlatformImageAssetInput,
  CreatePlatformUserInput,
  CreateProvisionJobInput,
  CreateProvisionJobStepLogInput,
  CreateSingleInstanceBatchInput,
  CreateRangeInstanceInput,
  CreateRangeTemplateInput,
  ImageCatalogItemRecord,
  ListImageCatalogItemsFilter,
  ListImageSnapshotsFilter,
  ListPlatformImageAssetsFilter,
  PlatformUserRecord,
  PlatformImageAssetRecord,
  ProvisionJobRecord,
  ProvisionJobStepLogRecord,
  ReconcileImageSnapshotsInput,
  RangeInstanceRecord,
  SingleInstanceBatchRecord,
  SingleInstanceBatchWithInstancesRecord,
  RangeTemplateRecord,
  UpsertImageSnapshotsInput,
  UpdatePlatformUserInput,
  UpdateProvisionJobInput,
  UpdateProvisionJobStepLogInput,
  UpdateRangeInstanceInput,
  UpdateRangeTemplateInput,
} from '../admin/admin.repository';
import { toAccountScopeKey } from '../admin/image-account-scope';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaAdminRepository implements AdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createPlatformUser(input: CreatePlatformUserInput): Promise<PlatformUserRecord> {
    return this.prisma.platformUser.create({
      data: {
        id: input.id,
        username: input.username,
        passwordHash: input.passwordHash,
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

  async updatePlatformUser(id: string, input: UpdatePlatformUserInput): Promise<PlatformUserRecord> {
    return this.prisma.platformUser.update({
      where: { id },
      data: {
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.passwordHash !== undefined ? { passwordHash: input.passwordHash } : {}),
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

  async updateRangeTemplate(id: string, input: UpdateRangeTemplateInput): Promise<RangeTemplateRecord> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.rangeTemplate.findUniqueOrThrow({
        where: { id },
        include: { currentDraftVersion: true, currentPublishedVersion: true },
      });
      if (existing.currentDraftVersionId) {
        await tx.rangeTemplateVersion.update({
          where: { id: existing.currentDraftVersionId },
          data: {
            ...(input.version !== undefined ? { version: input.version } : {}),
            ...(input.modulePathOrRef !== undefined ? { modulePathOrRef: input.modulePathOrRef } : {}),
            ...(input.topologySpec !== undefined ? { topologySpec: input.topologySpec as Prisma.InputJsonValue } : {}),
            ...(input.topologyGraph !== undefined
              ? {
                  topologyGraph: input.topologyGraph as
                    | Prisma.InputJsonValue
                    | Prisma.NullableJsonNullValueInput,
                }
              : {}),
            ...(input.scenarioTemplateSpec !== undefined
              ? {
                  scenarioTemplateSpec: input.scenarioTemplateSpec as
                    | Prisma.InputJsonValue
                    | Prisma.NullableJsonNullValueInput,
                }
              : {}),
            ...(input.compiledProvisionSpec !== undefined
              ? {
                  compiledProvisionSpec: input.compiledProvisionSpec as
                    | Prisma.InputJsonValue
                    | Prisma.NullableJsonNullValueInput,
                }
              : {}),
            ...(input.compiledSpec !== undefined
              ? {
                  compiledSpec: input.compiledSpec as
                    | Prisma.InputJsonValue
                    | Prisma.NullableJsonNullValueInput,
                }
              : {}),
            ...(input.variableSchema !== undefined
              ? { variableSchema: input.variableSchema as Prisma.InputJsonValue }
              : {}),
            ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema as Prisma.InputJsonValue } : {}),
            ...(input.defaultNetworkPolicy !== undefined
              ? { defaultNetworkPolicy: input.defaultNetworkPolicy as Prisma.InputJsonValue }
              : {}),
          },
        });
      }

      await tx.rangeTemplate.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.version !== undefined ? { version: input.version } : {}),
          ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.cloudProvider !== undefined ? { cloudProvider: input.cloudProvider } : {}),
          ...(input.iacType !== undefined ? { iacType: input.iacType } : {}),
          ...(input.modulePathOrRef !== undefined ? { modulePathOrRef: input.modulePathOrRef } : {}),
          ...(input.topologySpec !== undefined ? { topologySpec: input.topologySpec as Prisma.InputJsonValue } : {}),
          ...(input.topologyGraph !== undefined
            ? {
                topologyGraph: input.topologyGraph as
                  | Prisma.InputJsonValue
                  | Prisma.NullableJsonNullValueInput,
              }
            : {}),
          ...(input.scenarioTemplateSpec !== undefined
            ? {
                scenarioTemplateSpec: input.scenarioTemplateSpec as
                  | Prisma.InputJsonValue
                  | Prisma.NullableJsonNullValueInput,
              }
            : {}),
          ...(input.compiledProvisionSpec !== undefined
            ? {
                compiledProvisionSpec: input.compiledProvisionSpec as
                  | Prisma.InputJsonValue
                  | Prisma.NullableJsonNullValueInput,
              }
            : {}),
          ...(input.compiledSpec !== undefined
            ? {
                compiledSpec: input.compiledSpec as
                  | Prisma.InputJsonValue
                  | Prisma.NullableJsonNullValueInput,
              }
            : {}),
          ...(input.variableSchema !== undefined ? { variableSchema: input.variableSchema as Prisma.InputJsonValue } : {}),
          ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema as Prisma.InputJsonValue } : {}),
          ...(input.defaultNetworkPolicy !== undefined
            ? { defaultNetworkPolicy: input.defaultNetworkPolicy as Prisma.InputJsonValue }
            : {}),
        },
      });

      return tx.rangeTemplate.findUnique({
        where: { id },
        include: {
          currentDraftVersion: true,
          currentPublishedVersion: true,
          versions: true,
        },
      }) as Promise<RangeTemplateRecord>;
    });
  }

  async publishRangeTemplate(id: string): Promise<RangeTemplateRecord> {
    return this.prisma.$transaction(async (tx) => {
      const template = await tx.rangeTemplate.findUniqueOrThrow({
        where: { id },
        include: { currentDraftVersion: true },
      });

      if (!template.currentDraftVersion) {
        throw new Error('Current draft version not found');
      }

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
          compiledSpec: publishedVersion.compiledSpec as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
          variableSchema: publishedVersion.variableSchema as Prisma.InputJsonValue,
          outputSchema: publishedVersion.outputSchema as Prisma.InputJsonValue,
          defaultNetworkPolicy: publishedVersion.defaultNetworkPolicy as
            | Prisma.InputJsonValue
            | Prisma.NullableJsonNullValueInput,
        },
      });

      await tx.rangeTemplate.update({
        where: { id: template.id },
        data: {
          version: publishedVersion.version,
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
          currentPublishedVersionId: publishedVersion.id,
          currentDraftVersionId: nextDraft.id,
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

  async unpublishRangeTemplate(id: string): Promise<RangeTemplateRecord> {
    return this.prisma.$transaction(async (tx) => {
      const template = await tx.rangeTemplate.findUniqueOrThrow({
        where: { id },
        include: { currentPublishedVersion: true },
      });

      if (!template.currentPublishedVersion) {
        throw new Error('Current published version not found');
      }

      await tx.rangeTemplateVersion.update({
        where: { id: template.currentPublishedVersion.id },
        data: { status: 'archived' },
      });

      await tx.rangeTemplate.update({
        where: { id: template.id },
        data: {
          currentPublishedVersionId: null,
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

  async deleteRangeInstance(id: string): Promise<void> {
    await this.prisma.rangeInstance.delete({
      where: {
        id,
      },
    });
  }

  async createRangeInstance(input: CreateRangeInstanceInput): Promise<RangeInstanceRecord> {
    return this.prisma.rangeInstance.create({
      data: {
        name: input.name,
        createdBy: input.createdBy ?? 'admin',
        ownerUserId: input.ownerUserId ?? null,
        templateId: input.templateId ?? null,
        sourceTemplateVersionId: input.sourceTemplateVersionId ?? null,
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
        draftScenarioTemplateSpec: (input.draftScenarioTemplateSpec ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
        draftCompiledProvisionSpec: (input.draftCompiledProvisionSpec ?? null) as
          | Prisma.InputJsonValue
          | Prisma.NullableJsonNullValueInput,
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
      },
    }) as Promise<RangeInstanceRecord>;
  }

  async getRangeInstanceById(id: string): Promise<RangeInstanceRecord | null> {
    return this.prisma.rangeInstance.findUnique({
      where: {
        id,
      },
    }) as Promise<RangeInstanceRecord | null>;
  }

  async updateRangeInstance(id: string, input: UpdateRangeInstanceInput): Promise<RangeInstanceRecord> {
    return this.prisma.rangeInstance.update({
      where: {
        id,
      },
      data: {
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
      },
    }) as Promise<RangeInstanceRecord>;
  }

  async listProvisionJobs(): Promise<ProvisionJobRecord[]> {
    return this.prisma.provisionJob.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    }) as Promise<ProvisionJobRecord[]>;
  }

  async createProvisionJob(input: CreateProvisionJobInput): Promise<ProvisionJobRecord> {
    return this.prisma.provisionJob.create({
      data: {
        rangeInstanceId: input.rangeInstanceId,
        jobType: input.jobType,
        triggeredBy: input.triggeredBy,
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
    return this.prisma.platformImageAsset.findMany({
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
    }) as Promise<PlatformImageAssetRecord[]>;
  }

  async getPlatformImageAssetById(id: string): Promise<PlatformImageAssetRecord | null> {
    return this.prisma.platformImageAsset.findUnique({
      where: {
        id,
      },
    }) as Promise<PlatformImageAssetRecord | null>;
  }

  async collectPlatformImageAsset(input: CollectPlatformImageAssetInput): Promise<PlatformImageAssetRecord> {
    const snapshot = await this.prisma.cloudImageSnapshot.findUniqueOrThrow({
      where: {
        id: input.snapshotId,
      },
    });

    return this.prisma.platformImageAsset.upsert({
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
    }) as Promise<PlatformImageAssetRecord>;
  }

  async updatePlatformImageAsset(id: string, input: { displayName: string }): Promise<PlatformImageAssetRecord> {
    return this.prisma.platformImageAsset.update({
      where: {
        id,
      },
      data: {
        displayName: input.displayName,
      },
    }) as Promise<PlatformImageAssetRecord>;
  }

  async setPlatformImageAssetEnabled(id: string, enabled: boolean): Promise<PlatformImageAssetRecord> {
    return this.prisma.platformImageAsset.update({
      where: {
        id,
      },
      data: {
        enabled,
      },
    }) as Promise<PlatformImageAssetRecord>;
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

  async getSingleInstanceNetworkProfile(input: {
    provider: 'alibaba_cloud';
    regionId: string;
    zoneId: string;
  }) {
    return this.prisma.singleInstanceNetworkProfile.findUnique({
      where: {
        provider_regionId_zoneId: input,
      },
    }) as Promise<import('../admin/admin.repository').SingleInstanceNetworkProfileRecord | null>;
  }

  async upsertSingleInstanceNetworkProfile(input: import('../admin/admin.repository').UpsertSingleInstanceNetworkProfileInput) {
    return this.prisma.singleInstanceNetworkProfile.upsert({
      where: {
        provider_regionId_zoneId: {
          provider: input.provider,
          regionId: input.regionId,
          zoneId: input.zoneId,
        },
      },
      update: {
        vpcId: input.vpcId,
        vpcCidr: input.vpcCidr,
        vswitchIds: input.vswitchIds as Prisma.InputJsonValue,
        vswitchCidrs: input.vswitchCidrs as Prisma.InputJsonValue,
        securityGroupId: input.securityGroupId,
        securityGroupName: input.securityGroupName,
      },
      create: {
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
}
