export const TENCENTCLOUD_PROVIDER_VERSION = '1.83.34';
export const TENCENTCLOUD_PROVIDER_LINUX_AMD64_SHA256 =
  'c94c2074fef39d38b351c4e24190ec0bed6f7e1bc6b014f98a8672921eaf2c8b';

export type TencentCloudSingleInstanceMemberInput = {
  rangeInstanceId: string;
  ownerUserId: string;
  creationIntentId: string;
  instanceName: string;
  hostName?: string;
  instanceType: string;
  imageId: string;
  subnetId: string;
  systemDiskType?: 'CLOUD_PREMIUM' | 'CLOUD_SSD' | 'CLOUD_BSSD' | 'CLOUD_HSSD' | 'CLOUD_TSSD';
  systemDiskSize?: number;
  internetMaxBandwidthOut?: number;
  password: string;
};

export type TencentCloudSingleInstanceBatchRendererInput = {
  batchId: string;
  cloudAccountUid: string;
  region: string;
  zoneId: string;
  vpcId: string;
  securityGroupId: string;
  members: TencentCloudSingleInstanceMemberInput[];
};

export type TencentCloudOpenTofuRenderedVariables = {
  batch_id: string;
  cloud_account_uid: string;
  region: string;
  zone_id: string;
  vpc_id: string;
  security_group_id: string;
  members: Record<string, {
    instance_name: string;
    host_name: string;
    instance_type: string;
    image_id: string;
    subnet_id: string;
    system_disk_type: string;
    system_disk_size: number;
    internet_max_bandwidth_out: number;
    tags: Record<string, string>;
  }>;
  member_passwords: Record<string, string>;
};

function requireIdentity(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,126}$/.test(value)) {
    throw new Error(`Invalid Tencent Cloud ${field}`);
  }
}

function requireCloudId(value: string, prefix: string, field: string): void {
  if (!new RegExp(`^${prefix}-[a-z0-9]+$`).test(value)) {
    throw new Error(`Invalid Tencent Cloud ${field}`);
  }
}

/** Preparatory contract only: the official provider cannot accept a durable ClientToken. */
export class TencentCloudOpenTofuRenderer {
  render(input: TencentCloudSingleInstanceBatchRendererInput): TencentCloudOpenTofuRenderedVariables {
    requireIdentity(input.batchId, 'batch ID');
    if (!/^\d{1,32}$/.test(input.cloudAccountUid)) throw new Error('Invalid Tencent Cloud account UID');
    if (!/^[a-z]{2}-[a-z]+(?:-[a-z]+)*$/.test(input.region)
      || !input.zoneId.startsWith(`${input.region}-`)
      || !/^\d+$/.test(input.zoneId.slice(input.region.length + 1))) {
      throw new Error('Tencent Cloud region and zone must match');
    }
    requireCloudId(input.vpcId, 'vpc', 'VPC ID');
    requireCloudId(input.securityGroupId, 'sg', 'security group ID');
    if (input.members.length > 99) throw new Error('Tencent Cloud batch cannot exceed 99 members');

    const members: TencentCloudOpenTofuRenderedVariables['members'] = Object.create(null);
    const passwords: Record<string, string> = Object.create(null);
    const creationIntents = new Set<string>();
    for (const member of input.members) {
      requireIdentity(member.rangeInstanceId, 'member ID');
      requireIdentity(member.ownerUserId, 'owner ID');
      requireIdentity(member.creationIntentId, 'creation intent ID');
      if (Object.hasOwn(members, member.rangeInstanceId) || creationIntents.has(member.creationIntentId)) {
        throw new Error('Tencent Cloud member IDs and creation intent IDs must be unique');
      }
      creationIntents.add(member.creationIntentId);
      requireCloudId(member.imageId, 'img', 'image ID');
      requireCloudId(member.subnetId, 'subnet', 'subnet ID');
      if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Z0-9]+$/.test(member.instanceType)) {
        throw new Error('Invalid Tencent Cloud instance type');
      }
      const instanceName = member.instanceName.trim();
      if (!instanceName || instanceName.length > 60 || /[\u0000-\u001f\u007f]/.test(instanceName)) {
        throw new Error('Invalid Tencent Cloud instance name');
      }
      const hostName = member.hostName?.trim() ?? '';
      if (hostName && (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,58}[a-zA-Z0-9]$/.test(hostName)
        || hostName.includes('..'))) throw new Error('Invalid Tencent Cloud host name');
      const diskType = member.systemDiskType ?? 'CLOUD_PREMIUM';
      if (!['CLOUD_PREMIUM', 'CLOUD_SSD', 'CLOUD_BSSD', 'CLOUD_HSSD', 'CLOUD_TSSD'].includes(diskType)) {
        throw new Error('Tencent Cloud single instances require a managed cloud system disk');
      }
      const diskSize = member.systemDiskSize ?? 50;
      const bandwidth = member.internetMaxBandwidthOut ?? 0;
      if (!Number.isInteger(diskSize) || diskSize < 20 || diskSize > 1024) {
        throw new Error('Invalid Tencent Cloud system disk size');
      }
      if (!Number.isInteger(bandwidth) || bandwidth < 0 || bandwidth > 100) {
        throw new Error('Invalid Tencent Cloud public bandwidth');
      }
      if (!member.password || member.password.length < 8 || member.password.length > 30) {
        throw new Error('Invalid Tencent Cloud instance password length');
      }
      members[member.rangeInstanceId] = {
        instance_name: instanceName,
        host_name: hostName,
        instance_type: member.instanceType,
        image_id: member.imageId,
        subnet_id: member.subnetId,
        system_disk_type: diskType,
        system_disk_size: diskSize,
        internet_max_bandwidth_out: bandwidth,
        tags: {
          RangeInstanceId: member.rangeInstanceId,
          OwnerUserId: member.ownerUserId,
          PlatformUserId: member.ownerUserId,
          CloudAccountUid: input.cloudAccountUid,
          SingleInstanceBatchId: input.batchId,
          CreationIntentId: member.creationIntentId,
          CreatedBy: 'cyber-range-platform',
          PlatformScope: 'single-instance',
          PlatformResourceType: 'cvm',
        },
      };
      passwords[member.rangeInstanceId] = member.password;
    }
    return {
      batch_id: input.batchId,
      cloud_account_uid: input.cloudAccountUid,
      region: input.region,
      zone_id: input.zoneId,
      vpc_id: input.vpcId,
      security_group_id: input.securityGroupId,
      members,
      member_passwords: passwords,
    };
  }
}
