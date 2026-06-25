import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../../packages/database/generated/client';
import {
  AdminRepository,
  CompetitionRecord,
  CreateCompetitionInput,
  CreateProvisionJobInput,
  CreateProvisionJobStepLogInput,
  CreateRangeInstanceInput,
  CreateRangeTemplateInput,
  CreateTeamInput,
  ProvisionJobRecord,
  ProvisionJobStepLogRecord,
  RangeInstanceRecord,
  RangeTemplateRecord,
  TeamRecord,
  UpdateProvisionJobInput,
  UpdateProvisionJobStepLogInput,
  UpdateRangeInstanceInput,
  UpdateCompetitionInput,
  UpdateRangeTemplateInput,
  UpdateTeamInput,
} from '../admin/admin.repository';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaAdminRepository implements AdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listCompetitions(): Promise<CompetitionRecord[]> {
    return this.prisma.competition.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async createCompetition(input: CreateCompetitionInput): Promise<CompetitionRecord> {
    return this.prisma.competition.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        status: input.status ?? 'draft',
        startAt: input.startAt ? new Date(input.startAt) : null,
        endAt: input.endAt ? new Date(input.endAt) : null,
        defaultTemplateId: input.defaultTemplateId ?? null,
      },
    });
  }

  async getCompetitionById(id: string): Promise<CompetitionRecord | null> {
    return this.prisma.competition.findUnique({
      where: {
        id,
      },
    });
  }

  async updateCompetition(id: string, input: UpdateCompetitionInput): Promise<CompetitionRecord> {
    return this.prisma.competition.update({
      where: {
        id,
      },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.startAt ? { startAt: new Date(input.startAt) } : {}),
        ...(input.endAt ? { endAt: new Date(input.endAt) } : {}),
        ...(input.defaultTemplateId !== undefined ? { defaultTemplateId: input.defaultTemplateId } : {}),
      },
    });
  }

  async deleteCompetition(id: string): Promise<void> {
    await this.prisma.competition.delete({
      where: {
        id,
      },
    });
  }

  async listTeams(filter?: { competitionId?: string }): Promise<TeamRecord[]> {
    return this.prisma.team.findMany({
      where: filter?.competitionId
        ? {
            competitionId: filter.competitionId,
          }
        : undefined,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async createTeam(input: CreateTeamInput): Promise<TeamRecord> {
    return this.prisma.team.create({
      data: {
        competitionId: input.competitionId,
        name: input.name,
        contactName: input.contactName ?? null,
        contactEmailOrPhone: input.contactEmailOrPhone ?? null,
        notes: input.notes ?? null,
      },
    });
  }

  async getTeamById(id: string): Promise<TeamRecord | null> {
    return this.prisma.team.findUnique({
      where: {
        id,
      },
    });
  }

  async updateTeam(id: string, input: UpdateTeamInput): Promise<TeamRecord> {
    return this.prisma.team.update({
      where: {
        id,
      },
      data: {
        ...(input.competitionId ? { competitionId: input.competitionId } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.contactName !== undefined ? { contactName: input.contactName } : {}),
        ...(input.contactEmailOrPhone !== undefined ? { contactEmailOrPhone: input.contactEmailOrPhone } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
  }

  async deleteTeam(id: string): Promise<void> {
    await this.prisma.team.delete({
      where: {
        id,
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

  async createRangeTemplate(input: CreateRangeTemplateInput): Promise<RangeTemplateRecord> {
    return this.prisma.$transaction(async (tx) => {
      const template = await tx.rangeTemplate.create({
        data: {
          name: input.name,
          slug: input.slug,
          version: input.version,
          cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
          iacType: input.iacType ?? 'opentofu',
          modulePathOrRef: input.modulePathOrRef,
          topologySpec: input.topologySpec as Prisma.InputJsonValue,
          topologyGraph: (input.topologyGraph ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
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

      const draftVersion = await tx.rangeTemplateVersion.create({
        data: {
          templateId: template.id,
          version: input.version,
          status: 'draft',
          modulePathOrRef: input.modulePathOrRef,
          topologySpec: input.topologySpec as Prisma.InputJsonValue,
          topologyGraph: (input.topologyGraph ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
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
        include: { currentDraftVersion: true },
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
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.version !== undefined ? { version: input.version } : {}),
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

  async deleteRangeTemplate(id: string): Promise<void> {
    await this.prisma.rangeTemplate.delete({
      where: {
        id,
      },
    });
  }

  async listRangeInstances(): Promise<RangeInstanceRecord[]> {
    return this.prisma.rangeInstance.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    }) as Promise<RangeInstanceRecord[]>;
  }

  async createRangeInstance(input: CreateRangeInstanceInput): Promise<RangeInstanceRecord> {
    return this.prisma.rangeInstance.create({
      data: {
        competitionId: input.competitionId,
        teamId: input.teamId,
        templateId: input.templateId,
        status: input.status ?? 'draft',
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
}
