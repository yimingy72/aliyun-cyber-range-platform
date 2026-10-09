import type { CloudWorkspaceView, PlatformImageAsset } from './admin-types';

export function minimumSystemDiskSize(provider: CloudWorkspaceView['provider'], image?: Pick<PlatformImageAsset, 'minimumSystemDiskSize'> | null) {
  return Math.max(provider === 'tencent_cloud' ? 50 : 20, Math.ceil(image?.minimumSystemDiskSize ?? 0));
}

export function cloudExpiryError(expiresAt: string, provider: CloudWorkspaceView['provider'], now = Date.now()) {
  const time = new Date(expiresAt).getTime();
  if (!Number.isFinite(time)) return '请选择有效的到期时间。';
  const minimum = provider === 'tencent_cloud' ? 10 * 60_000 : 0;
  if (time <= now || time - now < minimum) return provider === 'tencent_cloud' ? '腾讯云实例到期时间至少需要在 10 分钟后。' : '到期时间必须晚于当前时间。';
  return null;
}

export function tencentImageError(image: PlatformImageAsset) {
  if (image.provider !== 'tencent_cloud') return '镜像与当前腾讯云工作空间不一致，请重新选择。';
  if (!['x86_64', 'amd64', 'x64'].includes(image.architecture?.toLowerCase() ?? '')) return '腾讯云实例仅支持已核验的 x86_64 镜像，请重新同步并选择镜像。';
  if (!Number.isFinite(image.minimumSystemDiskSize) || !image.minimumSystemDiskSize || image.minimumSystemDiskSize <= 0) return '镜像系统盘大小尚未核验，请在镜像中心重新同步后再创建实例。';
  return null;
}

export function verifiedTencentInstanceTypes(snapshot: import('./admin-types').InstanceTypeAvailabilitySnapshot, cpu: number, memory: number) {
  const matches = snapshot.matches.filter(match => match.cpu === cpu && match.memoryGiB === memory
    && ['x86_64', 'amd64', 'x64'].includes(match.architecture.toLowerCase()) && match.instanceTypeId && !match.instanceTypeId.startsWith('ecs.'));
  if (!snapshot.exactAvailable || snapshot.cpu !== cpu || snapshot.memory !== memory || !matches.length) throw new Error(`腾讯云默认可用区暂无 ${cpu} 核 / ${memory} G 的 x86_64 精确可售规格。`);
  return [...new Set(matches.map(match => match.instanceTypeId))];
}
