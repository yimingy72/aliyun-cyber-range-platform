import { cloudItems, cloudTotal, imageRpc } from './aliyun-image-rpc';

type Image = { ImageId?: string; Status?: string; Size?: unknown;
  DiskDeviceMappings?: { DiskDeviceMapping?: Array<{ Type?: string; Size?: unknown }> } };

export function aliyunImageMinimumSystemDiskSize(image: Image): number | null {
  const sizes = [image.Size, ...(image.DiskDeviceMappings?.DiskDeviceMapping ?? [])
    .filter(disk => disk.Type === 'system').map(disk => disk.Size)]
    .filter(value => typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
    .map(Number).filter(size => Number.isSafeInteger(size) && size > 0 && size <= 65_536);
  return sizes.length ? Math.max(...sizes) : null;
}

export async function readAliyunImageSystemDisk(account: { provider?: string; defaultRegion: string; accessKeyId: string; accessKeySecret: string }, imageId: string) {
  const body = await imageRpc<{ RequestId?: string }>(
    { ...account, regionId: account.defaultRegion }, 'DescribeImages', { ImageId: imageId, Status: 'ALL', PageNumber: '1', PageSize: '100' });
  const images = cloudItems<Image>(body, 'Images', 'Image');
  const image = images[0];
  const minimumSystemDiskSize = image && aliyunImageMinimumSystemDiskSize(image);
  if (cloudTotal(body) !== 1 || images.length !== 1 || image.ImageId !== imageId || image.Status !== 'Available'
    || !minimumSystemDiskSize || typeof body.RequestId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(body.RequestId)
    || [account.accessKeyId, account.accessKeySecret].some(secret => secret && body.RequestId!.includes(secret))) {
    throw new Error('阿里云镜像不可用或系统盘容量未通过云端核验，请重新同步镜像后再创建。');
  }
  return { imageId, minimumSystemDiskSize, requestId: body.RequestId };
}
