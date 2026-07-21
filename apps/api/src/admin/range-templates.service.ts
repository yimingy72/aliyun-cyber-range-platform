import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  CreateRangeTemplateInput,
  RangeTemplateCompiledSpec,
  RangeTemplateVersionRecord,
  RangeTemplateTopologySpec,
  UpdateRangeTemplateInput,
} from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { attachCreatedByUsernames } from './creator-display';

type ExistingRangeTemplate = NonNullable<Awaited<ReturnType<AdminRepository['getRangeTemplateById']>>>;
type AuthenticatedUser = Pick<SessionUserProfile, 'id' | 'role'>;
type RangeTemplateView = 'platform' | 'mine';
type EcsImageSelection = {
  platformImageAssetId: string;
  imageId: string;
};
type TemplateEcsImageValidationInput = {
  topologyGraph?: Record<string, unknown>;
  topologySpec?: RangeTemplateTopologySpec | null;
  scenarioTemplateSpec?: Record<string, unknown> | null;
  compiledProvisionSpec?: Record<string, unknown> | null;
  compiledSpec?: Record<string, unknown> | null;
};

@Injectable()
export class RangeTemplatesService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository) {}

  async list(currentUser?: AuthenticatedUser, viewText?: string) {
    const templates = await this.adminRepository.listRangeTemplates();

    if (!currentUser) {
      return this.withCreatorUsernames(templates.map((template) => toRangeTemplateListItem(template)));
    }

    const view = this.normalizeView(viewText);
    const visibleTemplates = templates.filter((template) => {
      if (view === 'mine') {
        return template.ownerUserId === currentUser.id;
      }

      if (template.visibility !== 'platform') {
        return false;
      }

      if (currentUser.role === 'admin' || template.ownerUserId === currentUser.id) {
        return true;
      }

      return Boolean(template.currentPublishedVersionId);
    });

    return this.withCreatorUsernames(visibleTemplates.map((template) => toRangeTemplateListItem(template)));
  }

  async getById(id: string, currentUser?: AuthenticatedUser) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    if (!currentUser) {
      return this.withCreatorUsername(existingTemplate);
    }

    this.assertTemplateReadable(existingTemplate, currentUser);

    if (!this.isSharedTemplateConsumer(existingTemplate, currentUser)) {
      return this.withCreatorUsername(existingTemplate);
    }

    const sourceVersion = await this.resolveTemplateConsumptionVersion(existingTemplate, currentUser);

    if (!sourceVersion) {
      throw new ConflictException('Shared template must be published before other users can consume it');
    }

    return this.withCreatorUsername({
      ...existingTemplate,
      version: sourceVersion.version,
      modulePathOrRef: sourceVersion.modulePathOrRef,
      topologySpec: sourceVersion.topologySpec,
      topologyGraph: sourceVersion.topologyGraph,
      scenarioTemplateSpec: sourceVersion.scenarioTemplateSpec,
      compiledProvisionSpec: sourceVersion.compiledProvisionSpec,
      compiledSpec: sourceVersion.compiledSpec,
      variableSchema: sourceVersion.variableSchema,
      outputSchema: sourceVersion.outputSchema,
      defaultNetworkPolicy: sourceVersion.defaultNetworkPolicy,
      currentDraftVersionId: sourceVersion.id,
      currentDraftVersion: sourceVersion,
    });
  }

  async create(input: CreateRangeTemplateInput, currentUser?: AuthenticatedUser) {
    const actorId = currentUser?.id ?? input.createdBy ?? 'admin';

    this.validateOptionalJsonObject(input.topologyGraph, 'topologyGraph');
    this.validateOptionalJsonObject(input.scenarioTemplateSpec, 'scenarioTemplateSpec');
    this.validateOptionalJsonObject(input.compiledProvisionSpec, 'compiledProvisionSpec');
    this.validateOptionalJsonObject(input.compiledSpec, 'compiledSpec');
    this.validateTopologySpec(input.topologySpec);
    await this.assertTemplateEcsImageSelections(input, currentUser);

    const template = await this.adminRepository.createRangeTemplate({
      ...input,
      createdBy: actorId,
      ownerUserId: currentUser?.id ?? input.ownerUserId ?? null,
      visibility: currentUser ? 'private' : input.visibility ?? 'private',
    });

    return this.withCreatorUsername(template);
  }

  async clone(id: string, currentUser?: AuthenticatedUser) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    const sourceVersion = await this.resolveTemplateConsumptionVersion(existingTemplate, currentUser);
    const allowTemplateFallback = !this.isSharedTemplateConsumer(existingTemplate, currentUser);

    const topologySpec =
      sourceVersion?.topologySpec ??
      (allowTemplateFallback ? existingTemplate.topologySpec : null);
    const modulePathOrRef =
      sourceVersion?.modulePathOrRef ??
      (allowTemplateFallback ? existingTemplate.modulePathOrRef : null);

    if (!topologySpec) {
      throw new BadRequestException('Template topology spec not found');
    }

    if (!modulePathOrRef) {
      throw new BadRequestException('Template module path not found');
    }

    await this.assertTemplateEcsImageSelections(
      {
        topologyGraph:
          sourceVersion?.topologyGraph ?? (allowTemplateFallback ? existingTemplate.topologyGraph : undefined) ?? undefined,
        topologySpec,
        scenarioTemplateSpec:
          sourceVersion?.scenarioTemplateSpec ??
          (allowTemplateFallback ? existingTemplate.scenarioTemplateSpec : undefined) ??
          undefined,
        compiledProvisionSpec:
          sourceVersion?.compiledProvisionSpec ??
          (allowTemplateFallback ? existingTemplate.compiledProvisionSpec : undefined) ??
          undefined,
        compiledSpec:
          sourceVersion?.compiledSpec ?? (allowTemplateFallback ? existingTemplate.compiledSpec : undefined) ?? undefined,
      },
      currentUser,
    );

    const rangeTemplates = await this.adminRepository.listRangeTemplates();
    const actorId = currentUser?.id ?? existingTemplate.createdBy;

    const template = await this.adminRepository.createRangeTemplate({
      name: `${existingTemplate.name} 副本`,
      createdBy: actorId,
      ownerUserId: currentUser?.id ?? existingTemplate.ownerUserId,
      description: existingTemplate.description ?? undefined,
      slug: this.buildClonedSlug(existingTemplate.slug, rangeTemplates.map((item) => item.slug)),
      visibility: 'private',
      version: sourceVersion?.version ?? (allowTemplateFallback ? existingTemplate.version : existingTemplate.version),
      cloudProvider: existingTemplate.cloudProvider,
      iacType: existingTemplate.iacType,
      modulePathOrRef,
      topologySpec,
      topologyGraph:
        sourceVersion?.topologyGraph ?? (allowTemplateFallback ? existingTemplate.topologyGraph : undefined) ?? undefined,
      scenarioTemplateSpec:
        sourceVersion?.scenarioTemplateSpec ??
        (allowTemplateFallback ? existingTemplate.scenarioTemplateSpec : undefined) ??
        undefined,
      compiledProvisionSpec:
        sourceVersion?.compiledProvisionSpec ??
        (allowTemplateFallback ? existingTemplate.compiledProvisionSpec : undefined) ??
        undefined,
      compiledSpec:
        sourceVersion?.compiledSpec ?? (allowTemplateFallback ? existingTemplate.compiledSpec : undefined) ?? undefined,
      variableSchema: sourceVersion?.variableSchema ?? (allowTemplateFallback ? existingTemplate.variableSchema : {}),
      outputSchema: sourceVersion?.outputSchema ?? (allowTemplateFallback ? existingTemplate.outputSchema : {}),
      defaultNetworkPolicy:
        sourceVersion?.defaultNetworkPolicy ??
        (allowTemplateFallback ? existingTemplate.defaultNetworkPolicy : undefined) ??
        undefined,
    });

    return this.withCreatorUsername(template);
  }

  async update(id: string, input: UpdateRangeTemplateInput, currentUser?: AuthenticatedUser) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    if (currentUser) {
      this.assertTemplateOwnerOrAdmin(existingTemplate, currentUser);
    }

    const topologySpec = input.topologySpec ?? existingTemplate.topologySpec;

    if (topologySpec) {
      this.validateTopologySpec(topologySpec);
    }

    this.validateOptionalJsonObject(input.topologyGraph, 'topologyGraph');
    this.validateOptionalJsonObject(input.scenarioTemplateSpec, 'scenarioTemplateSpec');
    this.validateOptionalJsonObject(input.compiledProvisionSpec, 'compiledProvisionSpec');
    this.validateOptionalJsonObject(input.compiledSpec, 'compiledSpec');
    await this.assertTemplateEcsImageSelections(
      {
        topologyGraph:
          input.topologyGraph ?? existingTemplate.currentDraftVersion?.topologyGraph ?? existingTemplate.topologyGraph ?? undefined,
        topologySpec,
        scenarioTemplateSpec:
          input.scenarioTemplateSpec ??
          existingTemplate.currentDraftVersion?.scenarioTemplateSpec ??
          existingTemplate.scenarioTemplateSpec ??
          undefined,
        compiledProvisionSpec:
          input.compiledProvisionSpec ??
          existingTemplate.currentDraftVersion?.compiledProvisionSpec ??
          existingTemplate.compiledProvisionSpec ??
          undefined,
        compiledSpec:
          input.compiledSpec ??
          existingTemplate.currentDraftVersion?.compiledSpec ??
          existingTemplate.compiledSpec ??
          undefined,
      },
      currentUser,
    );

    const template = await this.adminRepository.updateRangeTemplate(id, input);
    return this.withCreatorUsername(template);
  }

  async publish(id: string, currentUser?: AuthenticatedUser) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    if (currentUser) {
      this.assertTemplateOwnerOrAdmin(existingTemplate, currentUser);
    }

    await this.assertTemplateEcsImageSelections(
      this.getCurrentDraftTemplateEcsImageValidationInput(existingTemplate),
      currentUser,
    );
    this.assertTemplateReadyForPublish(existingTemplate);

    const template = await this.adminRepository.publishRangeTemplate(id);
    return this.withCreatorUsername(template);
  }

  async validate(id: string, currentUser?: AuthenticatedUser) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    if (this.isSharedTemplateConsumer(existingTemplate, currentUser)) {
      const sourceVersion = await this.resolveTemplateConsumptionVersion(existingTemplate, currentUser);

      await this.assertTemplateEcsImageSelections(
        {
          topologyGraph: sourceVersion?.topologyGraph ?? undefined,
          topologySpec: sourceVersion?.topologySpec ?? null,
          scenarioTemplateSpec: sourceVersion?.scenarioTemplateSpec ?? undefined,
          compiledProvisionSpec: sourceVersion?.compiledProvisionSpec ?? undefined,
          compiledSpec: sourceVersion?.compiledSpec ?? undefined,
        },
        currentUser,
      );

      this.assertTemplateStateReadyForPublish({
        scenarioTemplateSpec: sourceVersion?.scenarioTemplateSpec,
        compiledProvisionSpec: sourceVersion?.compiledProvisionSpec,
        topologySpec: sourceVersion?.topologySpec,
        compiledSpec: sourceVersion?.compiledSpec as RangeTemplateCompiledSpec | null | undefined,
      });

      return { valid: true as const };
    }

    if (currentUser) {
      this.assertTemplateReadable(existingTemplate, currentUser);
    }

    await this.assertTemplateEcsImageSelections(
      this.getCurrentDraftTemplateEcsImageValidationInput(existingTemplate),
      currentUser,
    );
    this.assertTemplateReadyForPublish(existingTemplate);

    return { valid: true as const };
  }

  async unpublish(id: string, currentUser?: AuthenticatedUser) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    if (currentUser) {
      this.assertTemplateOwnerOrAdmin(existingTemplate, currentUser);
    }

    if (!existingTemplate.currentPublishedVersionId) {
      throw new BadRequestException('Range template is not published');
    }

    const template = await this.adminRepository.unpublishRangeTemplate(id);
    return this.withCreatorUsername(template);
  }

  async share(id: string, currentUser?: AuthenticatedUser) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    if (currentUser) {
      this.assertTemplateOwnerOrAdmin(existingTemplate, currentUser);
    }

    const template = await this.adminRepository.updateRangeTemplate(id, { visibility: 'platform' });
    return this.withCreatorUsername(template);
  }

  async unshare(id: string, currentUser?: AuthenticatedUser) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    if (currentUser) {
      this.assertTemplateOwnerOrAdmin(existingTemplate, currentUser);
    }

    const template = await this.adminRepository.updateRangeTemplate(id, { visibility: 'private' });
    return this.withCreatorUsername(template);
  }

  async delete(id: string, currentUser?: AuthenticatedUser) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    if (currentUser) {
      this.assertTemplateOwnerOrAdmin(existingTemplate, currentUser);
    }

    const linkedInstances = (await this.adminRepository.listRangeInstances()).filter((instance) => instance.templateId === id);
    const blockingInstances = linkedInstances.filter((instance) => instance.status !== 'destroyed');

    if (blockingInstances.length > 0) {
      throw new ConflictException('Range template cannot be deleted while non-destroyed instances still reference it');
    }

    if (linkedInstances.length > 0) {
      await this.adminRepository.archiveDestroyedRangeInstancesForDeletedTemplate(existingTemplate);
    }

    try {
      await this.adminRepository.deleteRangeTemplate(id);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'P2003'
      ) {
        throw new ConflictException('Range template cannot be deleted while instances still reference it');
      }

      throw error;
    }
  }

  async resolveTemplateConsumptionVersion(
    template: ExistingRangeTemplate,
    currentUser?: AuthenticatedUser,
  ): Promise<RangeTemplateVersionRecord | null> {
    if (!currentUser || this.isTemplateOwnerOrAdmin(template, currentUser)) {
      return (
        template.currentDraftVersion ??
        (template.currentDraftVersionId
          ? await this.adminRepository.getRangeTemplateVersionById(template.currentDraftVersionId)
          : null) ??
        template.currentPublishedVersion ??
        (template.currentPublishedVersionId
          ? await this.adminRepository.getRangeTemplateVersionById(template.currentPublishedVersionId)
          : null)
      );
    }

    this.assertTemplateReadable(template, currentUser);

    const publishedVersion =
      template.currentPublishedVersion ??
      (template.currentPublishedVersionId
        ? await this.adminRepository.getRangeTemplateVersionById(template.currentPublishedVersionId)
        : null);

    if (!publishedVersion) {
      throw new ConflictException('Shared template must be published before other users can consume it');
    }

    return publishedVersion;
  }

  private normalizeView(viewText?: string): RangeTemplateView {
    if (!viewText || viewText === 'mine') {
      return 'mine';
    }

    if (viewText === 'platform') {
      return viewText;
    }

    throw new BadRequestException('view must be one of: platform, mine');
  }

  private assertTemplateReadable(template: ExistingRangeTemplate, currentUser: AuthenticatedUser) {
    if (this.isTemplateOwnerOrAdmin(template, currentUser)) {
      return;
    }

    if (template.visibility === 'platform') {
      return;
    }

    throw new ForbiddenException('Template access denied');
  }

  private assertTemplateOwnerOrAdmin(template: ExistingRangeTemplate, currentUser: AuthenticatedUser) {
    if (this.isTemplateOwnerOrAdmin(template, currentUser)) {
      return;
    }

    throw new ForbiddenException('Template access denied');
  }

  private isTemplateOwnerOrAdmin(template: ExistingRangeTemplate, currentUser: AuthenticatedUser) {
    return currentUser.role === 'admin' || template.ownerUserId === currentUser.id;
  }

  private isSharedTemplateConsumer(template: ExistingRangeTemplate, currentUser?: AuthenticatedUser) {
    if (!currentUser) {
      return false;
    }

    return !this.isTemplateOwnerOrAdmin(template, currentUser) && template.visibility === 'platform';
  }

  private buildClonedSlug(sourceSlug: string, existingSlugs: string[]) {
    const normalizedSlug = `${sourceSlug}-copy`;
    const slugSet = new Set(existingSlugs);

    if (!slugSet.has(normalizedSlug)) {
      return normalizedSlug;
    }

    let suffix = 2;

    while (slugSet.has(`${normalizedSlug}-${suffix}`)) {
      suffix += 1;
    }

    return `${normalizedSlug}-${suffix}`;
  }

  private getCurrentDraftTemplateEcsImageValidationInput(
    template: ExistingRangeTemplate,
  ): TemplateEcsImageValidationInput {
    return {
      topologyGraph: template.currentDraftVersion?.topologyGraph ?? template.topologyGraph ?? undefined,
      topologySpec: template.currentDraftVersion?.topologySpec ?? template.topologySpec,
      scenarioTemplateSpec:
        template.currentDraftVersion?.scenarioTemplateSpec ?? template.scenarioTemplateSpec ?? undefined,
      compiledProvisionSpec:
        template.currentDraftVersion?.compiledProvisionSpec ?? template.compiledProvisionSpec ?? undefined,
      compiledSpec: template.currentDraftVersion?.compiledSpec ?? template.compiledSpec ?? undefined,
    };
  }

  async assertTemplateEcsImageSelections(
    input: TemplateEcsImageValidationInput,
    currentUser?: AuthenticatedUser,
  ) {
    const selections = await this.assertTopologyGraphEcsImageSelections(
      input.topologyGraph,
      currentUser,
      input.topologySpec,
    );
    this.assertCompiledEcsImageSelections(input, selections);
  }

  private validateTopologySpec(topologySpec: RangeTemplateTopologySpec) {
    const zoneKeys = new Set<string>();
    const hostKeys = new Set<string>();

    for (const zone of topologySpec.networkZones) {
      if (zoneKeys.has(zone.key)) {
        throw new BadRequestException(`Duplicate network zone key: ${zone.key}`);
      }

      zoneKeys.add(zone.key);
    }

    for (const host of topologySpec.hosts) {
      if (hostKeys.has(host.key)) {
        throw new BadRequestException(`Duplicate host key: ${host.key}`);
      }

      if (!zoneKeys.has(host.zoneKey)) {
        throw new BadRequestException(`Host ${host.key} references unknown network zone: ${host.zoneKey}`);
      }

      hostKeys.add(host.key);
    }

    if (!hostKeys.has(topologySpec.publicEntry.hostKey)) {
      throw new BadRequestException(
        `Public entry host does not exist in hosts: ${topologySpec.publicEntry.hostKey}`,
      );
    }
  }

  async assertTopologyGraphEcsImageSelections(
    topologyGraph: Record<string, unknown> | undefined,
    currentUser?: AuthenticatedUser,
    topologySpec?: RangeTemplateTopologySpec | null,
  ): Promise<Record<string, EcsImageSelection>> {
    const nodes = Array.isArray(topologyGraph?.nodes) ? topologyGraph.nodes : [];
    const selectedImageIds: Record<string, EcsImageSelection> = {};

    for (const nodeValue of nodes) {
      if (!nodeValue || typeof nodeValue !== 'object') {
        continue;
      }

      const node = nodeValue as Record<string, unknown>;
      const nodeData = node.data && typeof node.data === 'object' ? (node.data as Record<string, unknown>) : node;
      const kind = typeof node.kind === 'string' ? node.kind : nodeData.kind;

      if (kind !== 'ecs') {
        continue;
      }

      const label =
        (typeof node.label === 'string' && node.label.trim()) ||
        (typeof nodeData.label === 'string' && nodeData.label.trim()) ||
        (typeof node.id === 'string' && node.id) ||
        'ECS';
      const platformImageAssetId =
        typeof nodeData.platformImageAssetId === 'string' ? nodeData.platformImageAssetId.trim() : '';

      if (!platformImageAssetId) {
        throw new BadRequestException(`${label} 请选择镜像`);
      }

      const asset = await this.adminRepository.getPlatformImageAssetById(platformImageAssetId);

      if (!asset || !asset.enabled) {
        throw new BadRequestException(`${label} 选择的镜像不可用`);
      }

      if (
        currentUser &&
        currentUser.role !== 'admin' &&
        asset.visibility !== 'platform' &&
        asset.ownerUserId !== currentUser.id
      ) {
        throw new ForbiddenException(`${label} 无权使用所选镜像`);
      }

      const selectedImageId = typeof nodeData.imageId === 'string' ? nodeData.imageId.trim() : '';
      const strategy = nodeData.imageStrategy && typeof nodeData.imageStrategy === 'object'
        ? (nodeData.imageStrategy as Record<string, unknown>)
        : null;
      const strategyImageId = typeof strategy?.imageId === 'string' ? strategy.imageId.trim() : '';

      if (selectedImageId !== asset.imageId || strategyImageId !== asset.imageId) {
        throw new BadRequestException(`${label} 的镜像配置与所选镜像不一致`);
      }

      const hostKey = typeof node.id === 'string' ? node.id.trim() : '';
      if (hostKey) {
        selectedImageIds[hostKey] = {
          platformImageAssetId,
          imageId: asset.imageId,
        };
      }
    }

    for (const host of topologySpec?.hosts ?? []) {
      if (!selectedImageIds[host.key]?.imageId) {
        throw new BadRequestException(`${host.name || host.key} 请选择镜像`);
      }
    }

    return selectedImageIds;
  }

  private assertCompiledEcsImageSelections(
    input: TemplateEcsImageValidationInput,
    selections: Record<string, EcsImageSelection>,
  ) {
    const assertHostSelection = (hostKey: string, value: unknown) => {
      const expected = selections[hostKey];

      if (!expected) {
        return;
      }

      const record = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
      const imageStrategy = record?.imageStrategy && typeof record.imageStrategy === 'object'
        ? (record.imageStrategy as Record<string, unknown>)
        : null;

      if (
        !record ||
        record.platformImageAssetId !== expected.platformImageAssetId ||
        record.imageId !== expected.imageId ||
        (imageStrategy && imageStrategy.imageId !== expected.imageId)
      ) {
        throw new BadRequestException(`${hostKey} 的编译镜像配置与所选镜像不一致`);
      }
    };

    const scenarioHosts = Array.isArray(input.scenarioTemplateSpec?.hosts) ? input.scenarioTemplateSpec.hosts : [];
    for (const hostValue of scenarioHosts) {
      const host = hostValue && typeof hostValue === 'object' && !Array.isArray(hostValue)
        ? (hostValue as Record<string, unknown>)
        : null;

      if (typeof host?.key === 'string') {
        assertHostSelection(host.key, host);
      }
    }

    const compiledProvisionHosts = Array.isArray(input.compiledProvisionSpec?.hosts)
      ? input.compiledProvisionSpec.hosts
      : [];
    for (const hostValue of compiledProvisionHosts) {
      const host = hostValue && typeof hostValue === 'object' && !Array.isArray(hostValue)
        ? (hostValue as Record<string, unknown>)
        : null;

      if (typeof host?.key === 'string') {
        assertHostSelection(host.key, host);
      }
    }

    const compiledResources = Array.isArray(input.compiledSpec?.resources) ? input.compiledSpec.resources : [];
    for (const resourceValue of compiledResources) {
      const resource = resourceValue && typeof resourceValue === 'object' && !Array.isArray(resourceValue)
        ? (resourceValue as Record<string, unknown>)
        : null;

      if (resource?.type === 'host' && typeof resource.id === 'string') {
        assertHostSelection(resource.id, resource.config);
      }
    }
  }

  private validateOptionalJsonObject(value: Record<string, unknown> | undefined, fieldName: string) {
    if (value === undefined) {
      return;
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException(`${fieldName} must be an object`);
    }
  }

  private validateScenarioTemplateSpec(scenarioTemplateSpec: Record<string, unknown>) {
    const topology = this.readJsonObject(scenarioTemplateSpec.topology, 'scenarioTemplateSpec.topology');
    const networkZones = this.readJsonArray(scenarioTemplateSpec.networkZones, 'scenarioTemplateSpec.networkZones');
    const hosts = this.readJsonArray(scenarioTemplateSpec.hosts, 'scenarioTemplateSpec.hosts');

    const zoneKeys = new Set<string>();
    const hostKeys = new Set<string>();

    for (const zoneValue of networkZones) {
      const zone = this.readJsonObject(zoneValue, 'scenarioTemplateSpec.networkZones[]');
      const zoneKey = this.readRequiredString(zone.key, 'scenarioTemplateSpec.networkZones[].key');

      if (zoneKeys.has(zoneKey)) {
        throw new BadRequestException(`Duplicate scenario network zone key: ${zoneKey}`);
      }

      zoneKeys.add(zoneKey);
    }

    for (const hostValue of hosts) {
      const host = this.readJsonObject(hostValue, 'scenarioTemplateSpec.hosts[]');
      const hostKey = this.readRequiredString(host.key, 'scenarioTemplateSpec.hosts[].key');
      const zoneKey = this.readRequiredString(host.zoneKey, `scenarioTemplateSpec.hosts[${hostKey}].zoneKey`);

      if (hostKeys.has(hostKey)) {
        throw new BadRequestException(`Duplicate scenario host key: ${hostKey}`);
      }

      if (!zoneKeys.has(zoneKey)) {
        throw new BadRequestException(`Scenario host ${hostKey} references unknown network zone: ${zoneKey}`);
      }

      hostKeys.add(hostKey);
    }

    const entryHostKey = this.readRequiredString(topology.entryHostKey, 'scenarioTemplateSpec.topology.entryHostKey');

    if (!hostKeys.has(entryHostKey)) {
      throw new BadRequestException(`Scenario entry host does not exist in hosts: ${entryHostKey}`);
    }
  }

  private assertTemplateReadyForPublish(existingTemplate: ExistingRangeTemplate) {
    const scenarioTemplateSpec =
      existingTemplate.currentDraftVersion?.scenarioTemplateSpec ?? existingTemplate.scenarioTemplateSpec;
    const compiledProvisionSpec =
      existingTemplate.currentDraftVersion?.compiledProvisionSpec ?? existingTemplate.compiledProvisionSpec;
    const topologySpec = existingTemplate.currentDraftVersion?.topologySpec ?? existingTemplate.topologySpec;

    if (!topologySpec && !scenarioTemplateSpec) {
      throw new BadRequestException('Template topology spec not found');
    }

    const compiledSpec = existingTemplate.currentDraftVersion?.compiledSpec as RangeTemplateCompiledSpec | null | undefined;

    this.assertTemplateStateReadyForPublish({
      scenarioTemplateSpec,
      compiledProvisionSpec,
      topologySpec,
      compiledSpec,
    });
  }

  private assertTemplateStateReadyForPublish(input: {
    scenarioTemplateSpec?: Record<string, unknown> | null;
    compiledProvisionSpec?: Record<string, unknown> | null;
    topologySpec?: RangeTemplateTopologySpec | null;
    compiledSpec?: RangeTemplateCompiledSpec | null;
  }) {
    const { scenarioTemplateSpec, compiledProvisionSpec, topologySpec, compiledSpec } = input;

    if (scenarioTemplateSpec) {
      this.validateScenarioTemplateSpec(scenarioTemplateSpec);
    }

    if (topologySpec) {
      this.validateTopologySpec(topologySpec);
    }

    if (compiledProvisionSpec) {
      this.validateCompiledProvisionSpec(compiledProvisionSpec, scenarioTemplateSpec);
    }

    if (compiledSpec?.topology && topologySpec) {
      this.validateCompiledTopologyConsistency(compiledSpec, topologySpec);
    }

    if (compiledSpec?.resources && topologySpec) {
      this.validateCompiledResourceCoverage(compiledSpec, topologySpec);
    }
  }

  private validateCompiledProvisionSpec(
    compiledProvisionSpec: Record<string, unknown>,
    scenarioTemplateSpec?: Record<string, unknown> | null,
  ) {
    const topology = this.readJsonObject(compiledProvisionSpec.topology, 'compiledProvisionSpec.topology');
    const networkZones = this.readJsonArray(compiledProvisionSpec.networkZones, 'compiledProvisionSpec.networkZones');
    const hosts = this.readJsonArray(compiledProvisionSpec.hosts, 'compiledProvisionSpec.hosts');
    const natGateways = this.readJsonArray(compiledProvisionSpec.natGateways, 'compiledProvisionSpec.natGateways');
    const eips = this.readJsonArray(compiledProvisionSpec.eips, 'compiledProvisionSpec.eips');
    const snatEntries = this.readJsonArray(compiledProvisionSpec.snatEntries, 'compiledProvisionSpec.snatEntries');
    const dnatEntries = this.readJsonArray(compiledProvisionSpec.dnatEntries, 'compiledProvisionSpec.dnatEntries');

    const zoneKeys = new Set<string>();
    const hostKeys = new Set<string>();
    const natGatewayKeys = new Set<string>();
    const eipKeys = new Set<string>();

    for (const zoneValue of networkZones) {
      const zone = this.readJsonObject(zoneValue, 'compiledProvisionSpec.networkZones[]');
      zoneKeys.add(this.readRequiredString(zone.key, 'compiledProvisionSpec.networkZones[].key'));
    }

    for (const hostValue of hosts) {
      const host = this.readJsonObject(hostValue, 'compiledProvisionSpec.hosts[]');
      const hostKey = this.readRequiredString(host.key, 'compiledProvisionSpec.hosts[].key');
      const zoneKey = this.readRequiredString(host.zoneKey, `compiledProvisionSpec.hosts[${hostKey}].zoneKey`);

      if (!zoneKeys.has(zoneKey)) {
        throw new BadRequestException(`Compiled provision host ${hostKey} references unknown network zone: ${zoneKey}`);
      }

      hostKeys.add(hostKey);
    }

    for (const natGatewayValue of natGateways) {
      const natGateway = this.readJsonObject(natGatewayValue, 'compiledProvisionSpec.natGateways[]');
      natGatewayKeys.add(this.readRequiredString(natGateway.key, 'compiledProvisionSpec.natGateways[].key'));
    }

    for (const eipValue of eips) {
      const eip = this.readJsonObject(eipValue, 'compiledProvisionSpec.eips[]');
      eipKeys.add(this.readRequiredString(eip.key, 'compiledProvisionSpec.eips[].key'));
    }

    const entryHostKey = this.readRequiredString(topology.entryHostKey, 'compiledProvisionSpec.topology.entryHostKey');

    if (!hostKeys.has(entryHostKey)) {
      throw new BadRequestException(`Compiled provision entry host does not exist in hosts: ${entryHostKey}`);
    }

    for (const snatEntryValue of snatEntries) {
      const snatEntry = this.readJsonObject(snatEntryValue, 'compiledProvisionSpec.snatEntries[]');
      const zoneKey = this.readRequiredString(snatEntry.zoneKey, 'compiledProvisionSpec.snatEntries[].zoneKey');
      const natGatewayKey = this.readRequiredString(
        snatEntry.natGatewayKey,
        'compiledProvisionSpec.snatEntries[].natGatewayKey',
      );
      const eipKey = this.readRequiredString(snatEntry.eipKey, 'compiledProvisionSpec.snatEntries[].eipKey');

      if (!zoneKeys.has(zoneKey)) {
        throw new BadRequestException(`Compiled provision SNAT entry references unknown network zone: ${zoneKey}`);
      }

      if (!natGatewayKeys.has(natGatewayKey)) {
        throw new BadRequestException(`Compiled provision SNAT entry references unknown nat gateway: ${natGatewayKey}`);
      }

      if (!eipKeys.has(eipKey)) {
        throw new BadRequestException(`Compiled provision SNAT entry references unknown EIP: ${eipKey}`);
      }
    }

    for (const dnatEntryValue of dnatEntries) {
      const dnatEntry = this.readJsonObject(dnatEntryValue, 'compiledProvisionSpec.dnatEntries[]');
      const hostKey = this.readRequiredString(dnatEntry.hostKey, 'compiledProvisionSpec.dnatEntries[].hostKey');
      const natGatewayKey = this.readRequiredString(
        dnatEntry.natGatewayKey,
        'compiledProvisionSpec.dnatEntries[].natGatewayKey',
      );
      const eipKey = this.readRequiredString(dnatEntry.eipKey, 'compiledProvisionSpec.dnatEntries[].eipKey');

      if (!hostKeys.has(hostKey)) {
        throw new BadRequestException(`Compiled provision DNAT entry references unknown host: ${hostKey}`);
      }

      if (!natGatewayKeys.has(natGatewayKey)) {
        throw new BadRequestException(`Compiled provision DNAT entry references unknown nat gateway: ${natGatewayKey}`);
      }

      if (!eipKeys.has(eipKey)) {
        throw new BadRequestException(`Compiled provision DNAT entry references unknown EIP: ${eipKey}`);
      }
    }

    if (scenarioTemplateSpec) {
      const scenarioTopology = this.readJsonObject(scenarioTemplateSpec.topology, 'scenarioTemplateSpec.topology');
      const scenarioVpcCidr = this.readRequiredString(
        scenarioTopology.vpcCidr,
        'scenarioTemplateSpec.topology.vpcCidr',
      );
      const compiledVpcCidr = this.readRequiredString(
        topology.vpcCidr,
        'compiledProvisionSpec.topology.vpcCidr',
      );

      if (scenarioVpcCidr !== compiledVpcCidr) {
        throw new BadRequestException('compiledProvisionSpec topology does not match scenarioTemplateSpec');
      }
    }
  }

  private readJsonObject(value: unknown, fieldName: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException(`${fieldName} must be an object`);
    }

    return value as Record<string, unknown>;
  }

  private readJsonArray(value: unknown, fieldName: string): unknown[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${fieldName} must be an array`);
    }

    return value;
  }

  private readRequiredString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`${fieldName} must be a non-empty string`);
    }

    return value;
  }

  private validateCompiledTopologyConsistency(
    compiledSpec: RangeTemplateCompiledSpec,
    topologySpec: RangeTemplateTopologySpec,
  ) {
    const compiledTopology = compiledSpec.topology;

    if (!compiledTopology) {
      return;
    }

    const zoneKeys = topologySpec.networkZones.map((zone) => zone.key);
    const hostKeys = topologySpec.hosts.map((host) => host.key);

    const matches =
      compiledTopology.vpcCidr === topologySpec.vpcCidr &&
      compiledTopology.publicEntryHostKey === topologySpec.publicEntry.hostKey &&
      this.sameOrderedValues(compiledTopology.networkZoneKeys, zoneKeys) &&
      this.sameOrderedValues(compiledTopology.hostKeys, hostKeys);

    if (!matches) {
      throw new BadRequestException('compiledSpec topology does not match topologySpec');
    }
  }

  private validateCompiledResourceCoverage(
    compiledSpec: RangeTemplateCompiledSpec,
    topologySpec: RangeTemplateTopologySpec,
  ) {
    const issues: string[] = [];
    const zoneKeys = new Set(topologySpec.networkZones.map((zone) => zone.key));
    const hostKeys = new Set(topologySpec.hosts.map((host) => host.key));
    const switchResourcesByZoneKey = new Map<string, Record<string, unknown>>();
    const hostResourcesById = new Map<string, Record<string, unknown>>();
    const natGatewayResourcesById = new Map<string, Record<string, unknown>>();
    const eipResourcesById = new Map<string, Record<string, unknown>>();

    for (const resource of compiledSpec.resources) {
      if (resource.type === 'switch') {
        const zoneKey = this.readString(resource.config?.zoneKey);

        if (zoneKey) {
          switchResourcesByZoneKey.set(zoneKey, resource.config);
        }
      }

      if (resource.type === 'host') {
        hostResourcesById.set(resource.id, resource.config);
      }

      if (resource.type === 'nat_gateway') {
        natGatewayResourcesById.set(resource.id, resource.config);
      }

      if (resource.type === 'eip') {
        eipResourcesById.set(resource.id, resource.config);
      }
    }

    for (const zone of topologySpec.networkZones) {
      const switchConfig = switchResourcesByZoneKey.get(zone.key);

      if (!switchConfig) {
        issues.push(`Missing switch resource for network zone: ${zone.key}`);
        continue;
      }

      const compiledCidr = this.readString(switchConfig.cidr);

      if (!compiledCidr) {
        issues.push(`Compiled switch resource is missing cidr for zone ${zone.key}`);
      } else if (compiledCidr !== zone.cidr) {
        issues.push(`Compiled switch resource cidr mismatch for zone ${zone.key}`);
      }
    }

    for (const host of topologySpec.hosts) {
      const hostConfig = hostResourcesById.get(host.key);

      if (!hostConfig) {
        issues.push(`Missing host resource for topology host: ${host.key}`);
        continue;
      }

      const compiledZoneKey = this.readString(hostConfig.zoneKey);
      const compiledRole = this.readString(hostConfig.role);
      const compiledPrivateIp = this.readString(hostConfig.privateIp);

      if (!compiledZoneKey) {
        issues.push(`Compiled host resource is missing zoneKey for host ${host.key}`);
      } else if (compiledZoneKey !== host.zoneKey) {
        issues.push(`Compiled host resource zoneKey mismatch for host ${host.key}`);
      }

      if (!compiledRole) {
        issues.push(`Compiled host resource is missing role for host ${host.key}`);
      } else if (compiledRole !== host.role) {
        issues.push(`Compiled host resource role mismatch for host ${host.key}`);
      }

      if (!compiledPrivateIp) {
        issues.push(`Compiled host resource is missing privateIp for host ${host.key}`);
      } else if (compiledPrivateIp !== host.privateIp) {
        issues.push(`Compiled host resource privateIp mismatch for host ${host.key}`);
      }
    }

    const publicEntryHostConfig = hostResourcesById.get(topologySpec.publicEntry.hostKey);

    if (!publicEntryHostConfig) {
      issues.push(`Missing host resource for topology host: ${topologySpec.publicEntry.hostKey}`);
    } else if (publicEntryHostConfig.exposePublic !== true) {
      issues.push(`Compiled public entry host must expose public access: ${topologySpec.publicEntry.hostKey}`);
    }

    for (const resource of compiledSpec.resources) {
      if (resource.type === 'nat_gateway') {
        const zoneKey = this.readString(resource.config?.zoneKey);

        if (!zoneKey) {
          issues.push(`Compiled nat gateway is missing zoneKey: ${resource.id}`);
        } else if (!zoneKeys.has(zoneKey)) {
          issues.push(`Compiled nat gateway references unknown network zone: ${zoneKey}`);
        }
      }

      if (resource.type === 'eip') {
        const bindTargetType = this.readString(resource.config?.bindTargetType);
        const bindTargetKey = this.readString(resource.config?.bindTargetKey);

        if (!bindTargetType) {
          issues.push(`Compiled EIP is missing bindTargetType: ${resource.id}`);
        }

        if (!bindTargetKey) {
          issues.push(`Compiled EIP is missing bindTargetKey: ${resource.id}`);
        } else if (bindTargetType === 'host' && !hostKeys.has(bindTargetKey)) {
          issues.push(`Compiled EIP references unknown host target: ${bindTargetKey}`);
        } else if (bindTargetType === 'nat_gateway' && !natGatewayResourcesById.has(bindTargetKey)) {
          issues.push(`Compiled EIP references unknown nat gateway target: ${bindTargetKey}`);
        }
      }

      if (resource.type === 'acl') {
        const zoneKey = this.readString(resource.config?.zoneKey);

        if (!zoneKey) {
          issues.push(`Compiled ACL is missing zoneKey: ${resource.id}`);
        } else if (!zoneKeys.has(zoneKey)) {
          issues.push(`Compiled ACL references unknown network zone: ${zoneKey}`);
        }
      }

      if (resource.type === 'security_group_rule') {
        const targetHostKey = this.readString(resource.config?.targetHostKey);

        if (!targetHostKey) {
          issues.push(`Compiled security group rule is missing targetHostKey: ${resource.id}`);
        } else if (!hostKeys.has(targetHostKey)) {
          issues.push(`Compiled security group rule references unknown host target: ${targetHostKey}`);
        }
      }

      if (resource.type === 'snat_entry') {
        const natGatewayKey = this.readString(resource.config?.natGatewayKey);
        const sourceZoneKey = this.readString(resource.config?.sourceZoneKey);
        const eipKey = this.readString(resource.config?.eipKey);

        if (!natGatewayKey) {
          issues.push(`Compiled SNAT entry is missing natGatewayKey: ${resource.id}`);
        } else if (!natGatewayResourcesById.has(natGatewayKey)) {
          issues.push(`Compiled SNAT entry references unknown nat gateway target: ${natGatewayKey}`);
        }

        if (!sourceZoneKey) {
          issues.push(`Compiled SNAT entry is missing sourceZoneKey: ${resource.id}`);
        } else if (!zoneKeys.has(sourceZoneKey)) {
          issues.push(`Compiled SNAT entry references unknown source network zone: ${sourceZoneKey}`);
        }

        if (!eipKey) {
          issues.push(`Compiled SNAT entry is missing eipKey: ${resource.id}`);
        } else if (!eipResourcesById.has(eipKey)) {
          issues.push(`Compiled SNAT entry references unknown EIP target: ${eipKey}`);
        }
      }

      if (resource.type === 'dnat_entry') {
        const natGatewayKey = this.readString(resource.config?.natGatewayKey);
        const eipKey = this.readString(resource.config?.eipKey);
        const backendHostKey = this.readString(resource.config?.backendHostKey);

        if (!natGatewayKey) {
          issues.push(`Compiled DNAT entry is missing natGatewayKey: ${resource.id}`);
        } else if (!natGatewayResourcesById.has(natGatewayKey)) {
          issues.push(`Compiled DNAT entry references unknown nat gateway target: ${natGatewayKey}`);
        }

        if (!eipKey) {
          issues.push(`Compiled DNAT entry is missing eipKey: ${resource.id}`);
        } else if (!eipResourcesById.has(eipKey)) {
          issues.push(`Compiled DNAT entry references unknown EIP target: ${eipKey}`);
        }

        if (!backendHostKey) {
          issues.push(`Compiled DNAT entry is missing backendHostKey: ${resource.id}`);
        } else if (!hostKeys.has(backendHostKey)) {
          issues.push(`Compiled DNAT entry references unknown backend host target: ${backendHostKey}`);
        }
      }
    }

    if (issues.length > 0) {
      throw new BadRequestException(issues);
    }
  }

  private readString(value: unknown) {
    return typeof value === 'string' && value.trim().length > 0 ? value : '';
  }

  private sameOrderedValues(left: string[], right: string[]) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  private async withCreatorUsername<T extends ExistingRangeTemplate>(template: T) {
    const [normalizedTemplate] = await attachCreatedByUsernames(this.adminRepository, [template]);
    return normalizedTemplate;
  }

  private withCreatorUsernames<T extends { createdBy: string; ownerUserId: string | null }>(templates: T[]) {
    return attachCreatedByUsernames(this.adminRepository, templates);
  }
}

function toRangeTemplateListItem(template: ExistingRangeTemplate) {
  const topologyGraph =
    template.currentDraftVersion?.topologyGraph ??
    template.currentPublishedVersion?.topologyGraph ??
    template.topologyGraph ??
    null;
  const topologySpec =
    template.currentDraftVersion?.topologySpec ??
    template.currentPublishedVersion?.topologySpec ??
    template.topologySpec ??
    null;

  return {
    id: template.id,
    name: template.name,
    createdBy: template.createdBy,
    ownerUserId: template.ownerUserId,
    description: template.description,
    slug: template.slug,
    version: template.version,
    cloudProvider: template.cloudProvider,
    iacType: template.iacType,
    modulePathOrRef: template.modulePathOrRef,
    visibility: template.visibility,
    currentDraftVersionId: template.currentDraftVersionId,
    currentPublishedVersionId: template.currentPublishedVersionId,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    nodeCount: topologyGraph && typeof topologyGraph === 'object' && Array.isArray(topologyGraph.nodes)
      ? topologyGraph.nodes.length
      : 0,
    zoneCount: Array.isArray(topologySpec?.networkZones) ? topologySpec.networkZones.length : 0,
    hostCount: Array.isArray(topologySpec?.hosts) ? topologySpec.hosts.length : 0,
  };
}
