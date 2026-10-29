import { describe, expect, it } from 'vitest';
import { cloudExpiryError, minimumSystemDiskSize, supportsRangeProvisioning, tencentImageError, verifiedTencentInstanceTypes } from './cloud-execution-policy';
import type { InstanceTypeAvailabilitySnapshot, PlatformImageAsset } from './admin-types';
const image = { provider: 'tencent_cloud', architecture: 'x86_64', minimumSystemDiskSize: 80 } as PlatformImageAsset;

describe('Tencent execution form policy', () => {
  it('fails closed for Tencent ranges without enabling or hiding supported single-instance features', () => {
    const capabilities = { provisioning: true, imageImport: true, billingSync: true };
    expect(supportsRangeProvisioning({ provider: 'tencent_cloud', capabilities })).toBe(false);
    expect(supportsRangeProvisioning({ provider: 'tencent_cloud', capabilities: { ...capabilities, rangeProvisioning: false } })).toBe(false);
    expect(supportsRangeProvisioning({ provider: 'tencent_cloud', capabilities: { ...capabilities, rangeProvisioning: true } })).toBe(true);
    expect(supportsRangeProvisioning({ provider: 'alibaba_cloud', capabilities })).toBe(true);
    expect(supportsRangeProvisioning({ provider: 'alibaba_cloud', capabilities: { ...capabilities, rangeProvisioning: false } })).toBe(false);
    expect(supportsRangeProvisioning()).toBe(true);
  });
  it('requires a minimum ten-minute expiry and the larger of platform minimum and verified image size', () => {
    const now = new Date('2026-10-10T00:00:00Z').getTime();
    expect(cloudExpiryError('2026-10-10T00:09:59Z', 'tencent_cloud', now)).toContain('10 分钟');
    expect(cloudExpiryError('2026-10-10T00:10:00Z', 'tencent_cloud', now)).toBeNull();
    expect(cloudExpiryError('invalid', 'tencent_cloud', now)).toContain('有效');
    expect(minimumSystemDiskSize('tencent_cloud')).toBe(50);
    expect(minimumSystemDiskSize('tencent_cloud', image)).toBe(80);
    expect(minimumSystemDiskSize('alibaba_cloud')).toBe(20);
  });
  it('rejects foreign/ARM/unknown-size images instead of guessing compatibility', () => {
    expect(tencentImageError(image)).toBeNull();
    expect(tencentImageError({ ...image, provider: 'alibaba_cloud' })).toContain('不一致');
    expect(tencentImageError({ ...image, architecture: 'arm_64' })).toContain('x86_64');
    expect(tencentImageError({ ...image, minimumSystemDiskSize: null })).toContain('尚未核验');
  });
  it('accepts only exact x86 Tencent instance types and never falls back to Aliyun ecs IDs', () => {
    const snapshot: InstanceTypeAvailabilitySnapshot = { cpu: 2, memory: 4, regionId: 'ap-shanghai', zoneId: 'ap-shanghai-1', exactAvailable: true, warning: null,
      matches: [{ instanceTypeId: 'S5.MEDIUM4', cpu: 2, memoryGiB: 4, family: 'S5', generation: 'S5', architecture: 'x86_64' },
        { instanceTypeId: 'ecs.c7.large', cpu: 2, memoryGiB: 4, family: 'ecs.c7', generation: '', architecture: 'x86_64' },
        { instanceTypeId: 'SR1.MEDIUM4', cpu: 2, memoryGiB: 4, family: 'SR1', generation: '', architecture: 'arm_64' }] };
    expect(verifiedTencentInstanceTypes(snapshot, 2, 4)).toEqual(['S5.MEDIUM4']);
    expect(() => verifiedTencentInstanceTypes(snapshot, 2, 2)).toThrow('精确可售');
    expect(() => verifiedTencentInstanceTypes({ ...snapshot, exactAvailable: false }, 2, 4)).toThrow('精确可售');
  });
});
