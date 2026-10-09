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
    if (!Array.isArray(result.ImageSet) || result.TotalCount !== requested.length || result.ImageSet.length !== requested.length || result.ImageSet.some(image => !image || typeof image !== 'object') || new Set(result.ImageSet.map(image => image.ImageId)).size !== requested.length || result.ImageSet.some(image => !requested.includes(image.ImageId) || image.ImageState !== 'NORMAL' || !['PUBLIC_IMAGE','PRIVATE_IMAGE'].includes(image.ImageType ?? '') || image.Architecture !== 'x86_64' || !Number.isSafeInteger(image.ImageSize) || Number(image.ImageSize) < 1 || !Array.isArray(image.SnapshotSet) || image.SnapshotSet.some(snapshot => !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || (snapshot as { DiskUsage?: unknown }).DiskUsage !== 'SYSTEM_DISK'))) throw new Error('Tencent host images must be available system-only images with complete disk metadata');
    for (const image of result.ImageSet) metadata[image.ImageId] = { minimumSystemDiskSize: Math.max(20,image.ImageSize!), architecture: image.Architecture! };
  }
  return metadata;
}
