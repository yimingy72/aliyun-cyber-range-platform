import { aliyunImageMinimumSystemDiskSize, readAliyunImageSystemDisk } from '../src/admin/aliyun-image-capacity';

const account = { provider: 'alibaba_cloud', defaultRegion: 'cn-beijing', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret' };
afterEach(() => jest.restoreAllMocks());

it('reads the exact available image system disk without counting its data disks', async () => {
  const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ RequestId: 'request-1', TotalCount: 1,
    Images: { Image: [{ ImageId: 'm-dc01', Status: 'Available', Size: 64,
      DiskDeviceMappings: { DiskDeviceMapping: [{ Type: 'system', Size: '64' }, { Type: 'data', Size: '200' }] } }] } })));
  expect(await readAliyunImageSystemDisk(account, 'm-dc01')).toEqual({ imageId: 'm-dc01', minimumSystemDiskSize: 64, requestId: 'request-1' });
  expect(new URL(String(request.mock.calls[0][0])).searchParams.get('ImageId')).toBe('m-dc01');
});

it.each([{ ImageId: 'm-foreign', Status: 'Available', Size: 64 }, { ImageId: 'm-dc01', Status: 'Creating', Size: 64 },
  { ImageId: 'm-dc01', Status: 'Available' }, { ImageId: 'm-dc01', Status: 'Available', Size: -1 }])
('refuses incomplete or mismatched official capacity: %j', async image => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ RequestId: 'request-1', TotalCount: 1, Images: { Image: [image] } })));
  await expect(readAliyunImageSystemDisk(account, 'm-dc01')).rejects.toThrow('云端核验');
});

it('does not invent a system disk capacity from a data-disk mapping', () => {
  expect(aliyunImageMinimumSystemDiskSize({ DiskDeviceMappings: { DiskDeviceMapping: [{ Type: 'data', Size: '200' }] } })).toBeNull();
});
