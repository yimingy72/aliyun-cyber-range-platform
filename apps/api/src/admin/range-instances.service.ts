import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  CreateRangeInstanceInput,
  RangeTemplateTopologySpec,
  RangeRuntimeCredentials,
} from './admin.repository';
import { SaveRangeInstanceDraftDto } from './dto/range-instance-draft.dto';
import { LaunchRangeInstanceDto } from './dto/range-instance.dto';
import { generateAliyunEcsPassword } from './ecs-password-generator';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { RangeTemplatesService } from './range-templates.service';
import { validateRangeInstanceDraftPayload } from './range-instance-draft.validation';
import { buildRangeRecoverySummary } from './range-instance-recovery';
import { SystemConfigService } from './system-config.service';
import { CidrPoolService } from '../provisioning/cidr-pool.service';
import { ProvisioningWorkerService } from '../provisioning/provisioning-worker.service';
import { compileTopologyGraph } from '../../../web/lib/template-compiler';

const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';

@Injectable()
export class RangeInstancesService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly rangeTemplatesService: RangeTemplatesService,
    private readonly systemConfigService: SystemConfigService,
    private readonly cidrPoolService: CidrPoolService,
    private readonly provisioningWorkerService: ProvisioningWorkerService,
  ) {}

  async list() {
    const instances = await this.adminRepository.listRangeInstances();

    return Promise.all(instances.map((instance) => this.attachRecoverySummary(instance)));
  }

  async getById(id: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    const hydrated = await this.attachRecoverySummary(instance);

    if (!hydrated) {
      throw new NotFoundException('Range instance not found');
    }

    const nodeStatuses = await this.resolveNodeStatuses(hydrated);

    return this.withDefaultInstancePassword({
      ...hydrated,
      nodeStatuses,
    });
  }

  async create(input: CreateRangeInstanceInput) {
    const template = await this.adminRepository.getRangeTemplateById(input.templateId);

    if (!template) {
      throw new NotFoundException('Range template not found');
    }

    const sourceTemplateVersionId = template.currentDraftVersionId ?? template.currentPublishedVersionId;

    if (!sourceTemplateVersionId) {
      throw new ConflictException('Range template does not have an active template version');
    }

    return this.adminRepository.createRangeInstance({
      ...input,
      sourceTemplateVersionId,
    });
  }

  async launch(input: LaunchRangeInstanceDto) {
    const template = await this.adminRepository.getRangeTemplateById(input.templateId);

    if (!template) {
      throw new NotFoundException('Range template not found');
    }

    const sourceTemplateVersion = template.currentDraftVersion ?? template.currentPublishedVersion;

    if (!sourceTemplateVersion) {
      throw new ConflictException('Range template does not have an active template version');
    }

    const runtimeScenarioTemplateSpec =
      sourceTemplateVersion.scenarioTemplateSpec ?? template.scenarioTemplateSpec ?? null;
    const runtimeCredentials = this.resolveRuntimeCredentials(runtimeScenarioTemplateSpec);

    const instance = await this.adminRepository.createRangeInstance({
      name: input.name,
      createdBy: input.triggeredBy,
      templateId: template.id,
      sourceTemplateVersionId: sourceTemplateVersion.id,
      runtimeTopologyGraph: sourceTemplateVersion.topologyGraph ?? template.topologyGraph ?? null,
      runtimeScenarioTemplateSpec,
      runtimeCompiledProvisionSpec:
        sourceTemplateVersion.compiledProvisionSpec ?? template.compiledProvisionSpec ?? null,
      runtimeCredentials,
      status: 'pending_create',
      expiresAt: input.expiresAt,
    });

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'create',
      triggeredBy: input.triggeredBy,
    });

    const updated = await this.adminRepository.updateRangeInstance(instance.id, {
      lastJobId: job.id,
    });

    this.provisioningWorkerService.dispatch(job.id);

    const hydrated = await this.attachRecoverySummary(updated);

    if (!hydrated) {
      throw new NotFoundException('Range instance not found');
    }

    return this.withDefaultInstancePassword(hydrated);
  }

  async saveDraft(id: string, input: SaveRangeInstanceDraftDto) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (instance.status !== 'running') {
      throw new ConflictException('Only running instances can save draft changes');
    }

    validateRangeInstanceDraftPayload(input);

    const updated = await this.adminRepository.updateRangeInstance(id, {
      draftTopologyGraph: input.draftTopologyGraph,
      draftScenarioTemplateSpec: input.draftScenarioTemplateSpec,
      draftCompiledProvisionSpec: input.draftCompiledProvisionSpec,
      draftUpdatedBy: input.draftUpdatedBy,
      draftUpdatedAt: new Date(),
    });

      const hydrated = await this.attachRecoverySummary(updated);

      if (!hydrated) {
        throw new NotFoundException('Range instance not found');
      }

      return this.withDefaultInstancePassword(hydrated);
  }

  async discardDraft(id: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    const updated = await this.adminRepository.updateRangeInstance(id, {
      draftTopologyGraph: null,
      draftScenarioTemplateSpec: null,
      draftCompiledProvisionSpec: null,
      draftUpdatedBy: null,
      draftUpdatedAt: null,
    });

    const hydrated = await this.attachRecoverySummary(updated);

    if (!hydrated) {
      throw new NotFoundException('Range instance not found');
    }

    return this.withDefaultInstancePassword(hydrated);
  }

  async applyDraft(id: string, triggeredBy: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (instance.status !== 'running') {
      throw new ConflictException('Only running instances can apply draft changes');
    }

    if (!instance.draftTopologyGraph || !instance.draftScenarioTemplateSpec || !instance.draftCompiledProvisionSpec) {
      throw new ConflictException('Range instance does not have a pending draft');
    }

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: id,
      jobType: 'update',
      triggeredBy,
    });

    await this.adminRepository.updateRangeInstance(id, {
      lastJobId: job.id,
      errorSummary: null,
    });

    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async syncTemplate(id: string, _triggeredBy: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (!instance.templateId) {
      throw new ConflictException('Range instance does not reference an active template');
    }

    const template = await this.adminRepository.getRangeTemplateById(instance.templateId);

    if (!template) {
      throw new NotFoundException('Range template not found');
    }

    const topologyGraph = instance.draftTopologyGraph ?? instance.runtimeTopologyGraph;
    const scenarioTemplateSpec = instance.draftScenarioTemplateSpec ?? instance.runtimeScenarioTemplateSpec;
    const compiledProvisionSpec =
      instance.draftCompiledProvisionSpec ?? instance.runtimeCompiledProvisionSpec;

    if (!topologyGraph || !scenarioTemplateSpec || !compiledProvisionSpec) {
      throw new ConflictException('Range instance does not have a complete topology snapshot to sync');
    }

    const topologySpec =
      this.readTopologySpecFromScenarioTemplateSpec(scenarioTemplateSpec) ??
      template.currentDraftVersion?.topologySpec ??
      template.topologySpec;

    if (!topologySpec) {
      throw new ConflictException('Unable to derive template topology spec from the instance snapshot');
    }

    const compiledSpec = this.buildCompiledSpecFromTopologyGraph(topologyGraph, topologySpec);

    return this.rangeTemplatesService.update(template.id, {
      topologySpec,
      topologyGraph,
      scenarioTemplateSpec,
      compiledProvisionSpec,
      ...(compiledSpec ? { compiledSpec } : {}),
    });
  }

  async triggerCreate(id: string, triggeredBy: string) {
    const job = await this.cidrPoolService.serialize(async () => {
      const instance = await this.adminRepository.getRangeInstanceById(id);

      if (!instance) {
        throw new NotFoundException('Range instance not found');
      }

       if (!instance.templateId) {
        throw new ConflictException('Range instance no longer references an active template');
      }

      const template = await this.adminRepository.getRangeTemplateById(instance.templateId);

      if (!template) {
        throw new NotFoundException('Range template not found');
      }

      const sourceTemplateVersion = instance.sourceTemplateVersionId
        ? await this.adminRepository.getRangeTemplateVersionById(instance.sourceTemplateVersionId)
        : template.currentDraftVersion ?? template.currentPublishedVersion;

      if (instance.sourceTemplateVersionId && !sourceTemplateVersion) {
        throw new ConflictException('Range instance source template version not found');
      }

      if (!['draft', 'create_failed', 'destroyed'].includes(instance.status)) {
        throw new ConflictException('Range instance cannot start a create job from the current status');
      }

      const occupiedCidrs = (await this.adminRepository.listRangeInstances())
        .filter((item) => item.id !== instance.id)
        .filter((item) => item.status !== 'destroyed')
        .map((item) => item.allocatedCidr)
        .filter((value): value is string => Boolean(value));

      const cidrPool = this.cidrPoolService.getPool();
      const effectiveTopologySpec =
        sourceTemplateVersion?.topologySpec ??
        template.currentDraftVersion?.topologySpec ??
        template.currentPublishedVersion?.topologySpec ??
        template.topologySpec;
      const fixedVpcCidr = effectiveTopologySpec?.vpcCidr ?? null;

      const allocatedCidr =
        instance.allocatedCidr ??
        fixedVpcCidr ??
        (cidrPool.length > 0 ? this.cidrPoolService.allocate(cidrPool, occupiedCidrs) : null);

      const nextJob = await this.adminRepository.createProvisionJob({
        rangeInstanceId: instance.id,
        jobType: 'create',
        triggeredBy,
      });

      await this.adminRepository.updateRangeInstance(instance.id, {
        allocatedCidr,
        status: 'pending_create',
        lastJobId: nextJob.id,
      });

      return nextJob;
    });

    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async triggerDestroy(id: string, triggeredBy: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (!instance.templateId) {
      throw new ConflictException('Range instance no longer references an active template');
    }

    if (!['running', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Range instance cannot start a destroy job from the current status');
    }

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'destroy',
      triggeredBy,
    });

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });

    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async triggerRetry(id: string, triggeredBy: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (!instance.templateId) {
      throw new ConflictException('Range instance no longer references an active template');
    }

    if (!['create_failed', 'destroy_failed'].includes(instance.status)) {
      throw new ConflictException('Range instance cannot start a retry job from the current status');
    }

    const previousJob = instance.lastJobId
      ? await this.adminRepository.getProvisionJobById(instance.lastJobId)
      : null;

    const retryCount = (previousJob?.retryCount ?? 0) + 1;
    const pendingStatus = instance.status === 'create_failed' ? 'pending_create' : 'pending_destroy';

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'retry',
      triggeredBy,
      retryCount,
    });

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: pendingStatus,
      errorSummary: null,
      lastJobId: job.id,
    });

    this.provisioningWorkerService.dispatch(job.id);

    return job;
  }

  async delete(id: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (instance.status !== 'create_failed') {
      throw new ConflictException('Only create_failed instances can be deleted');
    }

    await this.adminRepository.deleteRangeInstance(id);
  }

  private async attachRecoverySummary(instance: Awaited<ReturnType<AdminRepository['getRangeInstanceById']>>) {
    if (!instance) {
      return instance;
    }

    const lastJob = instance.lastJobId
      ? await this.adminRepository.getProvisionJobById(instance.lastJobId)
      : null;
    const steps = instance.lastJobId
      ? await this.adminRepository.listProvisionJobStepLogs(instance.lastJobId)
      : [];

    return {
      ...instance,
      recoverySummary: buildRangeRecoverySummary({
        instance,
        job: lastJob,
        steps,
      }),
    };
  }

  private withDefaultInstancePassword<T extends Record<string, unknown>>(payload: T) {
    const password = process.env.OPENTOFU_INSTANCE_PASSWORD?.trim() || null;

    return {
      ...payload,
      defaultInstancePassword: password,
    };
  }

  private async resolveNodeStatuses(instance: Awaited<ReturnType<AdminRepository['getRangeInstanceById']>>) {
    const hostIds = instance?.resourceSummary?.hostIds ?? null;

    if (!hostIds || Object.keys(hostIds).length === 0) {
      return null;
    }

    try {
      const accountContext = await this.systemConfigService.getAccountContext();
      const instanceIds = Object.values(hostIds).filter((value): value is string => Boolean(value));

      if (instanceIds.length === 0) {
        return null;
      }

      const payload = await this.performAliyunRpcRequest<{
        Instances?: {
          Instance?:
            | Array<{
                InstanceId?: string;
                Status?: string;
              }>
            | {
                InstanceId?: string;
                Status?: string;
              };
        };
      }>({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        action: 'DescribeInstances',
        parameters: {
          InstanceIds: JSON.stringify(instanceIds),
        },
      });

      const items = payload.Instances?.Instance;
      const normalized = Array.isArray(items) ? items : items ? [items] : [];
      const statusByInstanceId = new Map(
        normalized
          .filter((item) => typeof item?.InstanceId === 'string' && typeof item?.Status === 'string')
          .map((item) => [item.InstanceId as string, item.Status as string]),
      );

      return Object.fromEntries(
        Object.entries(hostIds).flatMap(([nodeId, cloudInstanceId]) => {
          const status = statusByInstanceId.get(cloudInstanceId);
          return status ? [[nodeId, status]] : [];
        }),
      );
    } catch {
      return null;
    }
  }

  private async performAliyunRpcRequest<ResponsePayload>(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    action: string;
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    const endpoint = `https://ecs.${input.regionId}.aliyuncs.com/`;
    const query = signAliyunRpcQuery(
      {
        Action: input.action,
        AccessKeyId: input.accessKeyId,
        Format: 'JSON',
        RegionId: input.regionId,
        SignatureMethod: ALICLOUD_SIGNATURE_METHOD,
        SignatureNonce: randomUUID(),
        SignatureVersion: ALICLOUD_SIGNATURE_VERSION,
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        Version: ALICLOUD_ECS_API_VERSION,
        ...(input.parameters ?? {}),
      },
      input.accessKeySecret,
    );
    const response = await fetch(`${endpoint}?${query}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Aliyun ${input.action} request failed with status ${response.status}`);
    }

    return (await response.json()) as ResponsePayload;
  }

  private resolveRuntimeCredentials(runtimeScenarioTemplateSpec: Record<string, unknown> | null) {
    const hosts = Array.isArray(runtimeScenarioTemplateSpec?.hosts) ? runtimeScenarioTemplateSpec.hosts : [];

    if (hosts.length === 0) {
      return null;
    }

    const runtimeCredentials: RangeRuntimeCredentials = {};

    for (const host of hosts) {
      if (!this.isRuntimeScenarioHost(host)) {
        continue;
      }

      const password = this.resolveHostPassword(host.accountPreset);
      runtimeCredentials[host.key] = {
        username: 'root',
        password,
      };
    }

    return Object.keys(runtimeCredentials).length > 0 ? runtimeCredentials : null;
  }

  private resolveHostPassword(accountPreset: { password?: unknown } | undefined) {
    if (typeof accountPreset?.password === 'string') {
      const normalizedPassword = accountPreset.password.trim();

      if (normalizedPassword.length > 0) {
        return normalizedPassword;
      }
    }

    return generateAliyunEcsPassword();
  }

  private isRuntimeScenarioHost(
    value: unknown,
  ): value is {
    key: string;
    accountPreset?: {
      password?: unknown;
    };
  } {
    if (!value || typeof value !== 'object') {
      return false;
    }

    if (typeof (value as { key?: unknown }).key !== 'string') {
      return false;
    }

    const accountPreset = (value as { accountPreset?: unknown }).accountPreset;

    return accountPreset === undefined || (accountPreset !== null && typeof accountPreset === 'object');
  }

  private readTopologySpecFromScenarioTemplateSpec(
    value: Record<string, unknown> | null | undefined,
  ): RangeTemplateTopologySpec | null {
    if (!value) {
      return null;
    }

    const topology = this.readRecord(value.topology);
    const networkZones = this.readArray(value.networkZones);
    const hosts = this.readArray(value.hosts);
    const publicEntryHostKey = typeof topology?.entryHostKey === 'string' ? topology.entryHostKey : null;
    const vpcCidr = typeof topology?.vpcCidr === 'string' ? topology.vpcCidr : null;

    if (!publicEntryHostKey || !vpcCidr || networkZones.length === 0 || hosts.length === 0) {
      return null;
    }

    return {
      vpcCidr,
      networkZones: networkZones.flatMap((zoneValue) => {
        const zone = this.readRecord(zoneValue);

        if (!zone || typeof zone.key !== 'string' || typeof zone.name !== 'string' || typeof zone.cidr !== 'string') {
          return [];
        }

        return [
          {
            key: zone.key,
            name: zone.name,
            purpose: typeof zone.purpose === 'string' ? zone.purpose : zone.key,
            cidr: zone.cidr,
            ...(zone.isPublicEntry === true ? { isPublicEntry: true } : {}),
          },
        ];
      }),
      hosts: hosts.flatMap((hostValue) => {
        const host = this.readRecord(hostValue);

        if (
          !host ||
          typeof host.key !== 'string' ||
          typeof host.name !== 'string' ||
          typeof host.zoneKey !== 'string' ||
          typeof host.role !== 'string' ||
          typeof host.primaryPrivateIp !== 'string'
        ) {
          return [];
        }

        return [
          {
            key: host.key,
            name: host.name,
            zoneKey: host.zoneKey,
            role: host.role,
            privateIp: host.primaryPrivateIp,
            ...(host.exposePublic === true ? { exposePublic: true } : {}),
          },
        ];
      }),
      publicEntry: {
        hostKey: publicEntryHostKey,
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    };
  }

  private buildCompiledSpecFromTopologyGraph(
    topologyGraph: Record<string, unknown>,
    topologySpec: RangeTemplateTopologySpec,
  ) {
    const rawNodes = this.readArray(topologyGraph.nodes).filter((node) => {
      const record = this.readRecord(node);
      return record && typeof record.id === 'string' && typeof record.kind === 'string';
    });

    if (rawNodes.length === 0) {
      return null;
    }

    return compileTopologyGraph({
      topologySpec,
      nodes: rawNodes as Parameters<typeof compileTopologyGraph>[0]['nodes'],
    });
  }

  private readRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private readArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }
}
