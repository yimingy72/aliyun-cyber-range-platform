import { Inject, Injectable } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  type AdminRepository,
  type SingleInstanceNetworkProfileRecord,
} from './admin.repository';
import { SystemConfigService } from './system-config.service';
import { CidrPoolService } from '../provisioning/cidr-pool.service';
import { SingleInstanceNetworkBootstrapService } from '../provisioning/single-instance-network-bootstrap';

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
    private readonly singleInstanceNetworkBootstrapService: SingleInstanceNetworkBootstrapService,
    private readonly cidrPoolService: CidrPoolService,
  ) {}

  async ensureDefaultProfile() {
    return this.cidrPoolService.serialize(async () => {
      const snapshot = await this.systemConfigService.getSnapshot();
      const existing = await this.adminRepository.getSingleInstanceNetworkProfile({
        provider: snapshot.provider,
        regionId: snapshot.defaultRegion,
        zoneId: snapshot.defaultZoneId,
      });

      if (existing && !isPlaceholderProfile(existing)) {
        return existing;
      }

      const occupiedCidrs = (await this.adminRepository.listRangeInstances())
        .map((instance) => instance.allocatedCidr)
        .filter((value): value is string => Boolean(value));
      const bootstrappedProfile =
        await this.singleInstanceNetworkBootstrapService.bootstrapDefaultProfile({
          provider: snapshot.provider,
          regionId: snapshot.defaultRegion,
          zoneId: snapshot.defaultZoneId,
          occupiedCidrs,
          runtimeConfig: {
            accessKeyId: snapshot.accessKeyId,
            accessKeySecret: snapshot.accessKeySecret,
            defaultRegion: snapshot.defaultRegion,
            defaultZoneId: snapshot.defaultZoneId,
          },
        });

      return this.adminRepository.upsertSingleInstanceNetworkProfile(bootstrappedProfile);
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

function isPlaceholderProfile(profile: SingleInstanceNetworkProfileRecord) {
  return (
    profile.vpcId.startsWith('vpc-default-') ||
    profile.securityGroupId.startsWith('sg-default-') ||
    profile.vswitchIds.some((vswitchId) => vswitchId.startsWith('vsw-default-'))
  );
}
