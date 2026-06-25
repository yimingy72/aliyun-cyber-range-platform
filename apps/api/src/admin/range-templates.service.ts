import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  CreateRangeTemplateInput,
  RangeTemplateCompiledSpec,
  RangeTemplateTopologySpec,
  UpdateRangeTemplateInput,
} from './admin.repository';

@Injectable()
export class RangeTemplatesService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository) {}

  list() {
    return this.adminRepository.listRangeTemplates();
  }

  create(input: CreateRangeTemplateInput) {
    this.validateOptionalJsonObject(input.topologyGraph, 'topologyGraph');
    this.validateOptionalJsonObject(input.compiledSpec, 'compiledSpec');
    this.validateTopologySpec(input.topologySpec);

    return this.adminRepository.createRangeTemplate(input);
  }

  async update(id: string, input: UpdateRangeTemplateInput) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    const topologySpec = input.topologySpec ?? existingTemplate.topologySpec;

    if (topologySpec) {
      this.validateTopologySpec(topologySpec);
    }

    this.validateOptionalJsonObject(input.topologyGraph, 'topologyGraph');
    this.validateOptionalJsonObject(input.compiledSpec, 'compiledSpec');

    return this.adminRepository.updateRangeTemplate(id, input);
  }

  async publish(id: string) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    const topologySpec = existingTemplate.currentDraftVersion?.topologySpec ?? existingTemplate.topologySpec;

    if (!topologySpec) {
      throw new BadRequestException('Template topology spec not found');
    }

    const compiledSpec = existingTemplate.currentDraftVersion?.compiledSpec as RangeTemplateCompiledSpec | null | undefined;

    this.validateTopologySpec(topologySpec);

    if (compiledSpec?.topology) {
      this.validateCompiledTopologyConsistency(compiledSpec, topologySpec);
    }

    if (compiledSpec?.resources) {
      this.validateCompiledResourceCoverage(compiledSpec, topologySpec);
    }

    return this.adminRepository.publishRangeTemplate(id);
  }

  async delete(id: string) {
    const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

    if (!existingTemplate) {
      throw new NotFoundException('Range template not found');
    }

    await this.adminRepository.deleteRangeTemplate(id);
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

  private validateOptionalJsonObject(value: Record<string, unknown> | undefined, fieldName: string) {
    if (value === undefined) {
      return;
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException(`${fieldName} must be an object`);
    }
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
}
