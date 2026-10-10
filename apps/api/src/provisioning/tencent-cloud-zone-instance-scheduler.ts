import { ConflictException } from '@nestjs/common';
import { requestTencentCloud } from '../admin/tencent-cloud-client';
import type { ResolvedProvisioningRuntimeConfig } from './provisioning.types';

export async function selectTencentHostInstanceTypes(account: ResolvedProvisioningRuntimeConfig, hosts: Array<{ key: string; cpu?: number; memory?: number; instanceType?: string; preferredInstanceTypes?: string[]; strictPreferredInstanceTypes?: boolean }>) {
  const payload = await requestTencentCloud<{ InstanceTypeQuotaSet: Array<{ Zone: string; InstanceChargeType: string; InstanceType: string; Cpu: number; Memory: number; Status: string; CpuType?: string }> }>({ service: 'cvm', version: '2017-03-12', action: 'DescribeZoneInstanceConfigInfos', regionId: account.defaultRegion,
    accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret, parameters: { Filters: [{ Name: 'zone', Values: [account.defaultZoneId] }, { Name: 'instance-charge-type', Values: ['POSTPAID_BY_HOUR'] }] } });
  if (!Array.isArray(payload.InstanceTypeQuotaSet) || payload.InstanceTypeQuotaSet.some(item => !item || item.Zone !== account.defaultZoneId || item.InstanceChargeType !== 'POSTPAID_BY_HOUR' || typeof item.InstanceType !== 'string' || !/^[A-Za-z0-9]+\.[A-Za-z0-9]+$/.test(item.InstanceType) || !Number.isSafeInteger(item.Cpu) || item.Cpu <= 0 || !Number.isFinite(item.Memory))) throw new Error('Tencent saleable type response is incomplete or outside the frozen zone');
  return Object.fromEntries(hosts.map(host => {
    const candidates = payload.InstanceTypeQuotaSet.filter(item => item.Status === 'SELL' && /\b(?:intel|amd|hygon)\b/i.test(item.CpuType ?? '') && (!host.cpu || host.cpu === item.Cpu) && (!host.memory || host.memory === item.Memory) && (!host.instanceType || host.instanceType === item.InstanceType));
    const preferred = host.preferredInstanceTypes?.map(type => candidates.find(item => item.InstanceType === type)).find(Boolean);
    if (host.strictPreferredInstanceTypes && host.preferredInstanceTypes?.length && !preferred) throw new Error(`No fixed Tencent type preference is saleable for ${host.key}`);
    const exact = preferred ?? candidates.sort((a,b) => a.InstanceType.localeCompare(b.InstanceType))[0];
    if (!exact || !host.instanceType && (!host.cpu || !host.memory)) throw new Error(`No exact saleable Tencent type in the frozen zone for ${host.key}`);
    return [host.key, { instanceType: exact.InstanceType, cpu: exact.Cpu }];
  }));
}

export async function assertTencentImagesAvailable(account: ResolvedProvisioningRuntimeConfig, imageIds: string[]) {
  const ids = [...new Set(imageIds)];
  if (!ids.length || ids.some(id => !/^img-[a-z0-9]+$/.test(id))) throw new Error('Tencent hosts require exact image IDs');
  const metadata: Record<string,{ minimumSystemDiskSize: number; architecture: string }> = {};
  for (let offset = 0; offset < ids.length; offset += 100) {
    const requested = ids.slice(offset,offset+100);
    const result = await requestTencentCloud<{ TotalCount: number; ImageSet: Array<{ ImageId: string; ImageState: string; SnapshotSet?: unknown; ImageType?: string; Architecture?: string; ImageSize?: number }> }>({ service: 'cvm', version: '2017-03-12', action: 'DescribeImages', regionId: account.defaultRegion, accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret, parameters: { ImageIds: requested, Limit: 100, Offset: 0 } });
    const reject = (reason: string): never => { throw new ConflictException(`Tencent host images must be available system-only images with complete disk metadata [${reason}]`); };
    if (!Array.isArray(result.ImageSet)) reject('ImageSet:shape');
    if (result.TotalCount !== requested.length || result.ImageSet.length !== requested.length) reject('ImageSet:count');
    if (result.ImageSet.some(image => !image || typeof image !== 'object' || Array.isArray(image))) reject('Image:shape');
    if (new Set(result.ImageSet.map(image => image.ImageId)).size !== requested.length || result.ImageSet.some(image => !requested.includes(image.ImageId))) reject('ImageId:identity');
    for (const image of result.ImageSet) {
      if (image.ImageState !== 'NORMAL') reject('ImageState:not-normal');
      if (!['PUBLIC_IMAGE','PRIVATE_IMAGE'].includes(image.ImageType ?? '')) reject('ImageType:unsupported');
      if (image.Architecture !== 'x86_64') reject('Architecture:unsupported');
      if (!Number.isSafeInteger(image.ImageSize) || Number(image.ImageSize) < 1) reject('ImageSize:missing-or-invalid');
      // Official PUBLIC_IMAGE metadata may explicitly return null; private backing disks must remain inspectable.
      if (image.ImageType === 'PUBLIC_IMAGE' && image.SnapshotSet === null) continue;
      const snapshots = Array.isArray(image.SnapshotSet) ? image.SnapshotSet : reject(image.SnapshotSet === undefined ? 'SnapshotSet:missing' : image.SnapshotSet === null ? 'SnapshotSet:private-null' : 'SnapshotSet:shape');
      for (const snapshot of snapshots) {
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) reject('SnapshotSet:entry-shape');
        if ((snapshot as { DiskUsage?: unknown }).DiskUsage === 'DATA_DISK') reject('SnapshotSet:data-disk');
        if ((snapshot as { DiskUsage?: unknown }).DiskUsage !== 'SYSTEM_DISK') reject('SnapshotSet:unknown-disk-usage');
      }
    }
    for (const image of result.ImageSet) metadata[image.ImageId] = { minimumSystemDiskSize: Math.max(20,image.ImageSize!), architecture: image.Architecture! };
  }
  return metadata;
}
