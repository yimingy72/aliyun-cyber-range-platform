import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  CreateRangeTemplateInput,
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

    return this.adminRepository.updateRangeTemplate(id, input);
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
}
