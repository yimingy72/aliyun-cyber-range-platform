import { Inject, Injectable } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type SingleInstanceNetworkProfileRecord,
} from './admin.repository';
import { SystemConfigService } from './system-config.service';

type AllocatedSingleInstanceNetwork = {
  vswitchId: string;
  vswitchCidr: string;
  zoneKey: string;
  privateIp: string;
};

@Injectable()
export class SingleInstanceNetworkService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async ensureDefaultProfile() {
    const snapshot = await this.systemConfigService.getSnapshot();
    const existing = await this.adminRepository.getSingleInstanceNetworkProfile({
      provider: snapshot.provider,
      regionId: snapshot.defaultRegion,
      zoneId: snapshot.defaultZoneId,
    });

    if (existing) {
      return existing;
    }

    return this.adminRepository.upsertSingleInstanceNetworkProfile({
      provider: snapshot.provider,
      regionId: snapshot.defaultRegion,
      zoneId: snapshot.defaultZoneId,
      vpcId: `vpc-default-${snapshot.defaultRegion}`,
      vpcCidr: '10.240.0.0/16',
      vswitchIds: [
        `vsw-default-${snapshot.defaultZoneId}-a`,
        `vsw-default-${snapshot.defaultZoneId}-b`,
        `vsw-default-${snapshot.defaultZoneId}-c`,
      ],
      vswitchCidrs: ['10.240.1.0/24', '10.240.2.0/24', '10.240.3.0/24'],
      securityGroupId: `sg-default-${snapshot.defaultZoneId}`,
      securityGroupName: 'single-instance-default',
    });
  }

  allocateVswitch(profile: SingleInstanceNetworkProfileRecord, offset: number): AllocatedSingleInstanceNetwork {
    const index = Math.abs(offset) % Math.min(profile.vswitchIds.length, profile.vswitchCidrs.length, 3);
    const vswitchId = profile.vswitchIds[index];
    const vswitchCidr = profile.vswitchCidrs[index];
    const zoneKey = `zone-${index + 1}`;
    const privateIp = this.allocatePrivateIp(vswitchCidr, offset);

    return {
      vswitchId,
      vswitchCidr,
      zoneKey,
      privateIp,
    };
  }

  private allocatePrivateIp(vswitchCidr: string, offset: number) {
    const [network] = vswitchCidr.split('/');
    const parts = network.split('.');
    const hostOctet = 10 + (Math.abs(offset) % 200);

    return `${parts[0]}.${parts[1]}.${parts[2]}.${hostOctet}`;
  }
}
