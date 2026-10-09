import { BadGatewayException, BadRequestException } from '@nestjs/common';

import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { TencentCloudCatalogService } from '../src/admin/tencent-cloud-catalog.service';
import { requestTencentCloud } from '../src/admin/tencent-cloud-client';

jest.mock('../src/admin/tencent-cloud-client', () => ({ ...jest.requireActual('../src/admin/tencent-cloud-client'), requestTencentCloud: jest.fn() }));

describe('Tencent cloud image catalog', () => {
  const request = jest.mocked(requestTencentCloud);
  const context = { id: 'tc-context', provider: 'tencent_cloud', accountUid: '100000000001', regionId: 'ap-guangzhou', zoneId: 'ap-guangzhou-3', accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' };
  const getCredentials = jest.fn();
  const catalog = new TencentCloudCatalogService({ getCredentials } as unknown as CloudAccountContextsService);
  const image = { ImageId: 'img-fixture1', ImageName: 'Ubuntu', ImageType: 'PRIVATE_IMAGE', ImageState: 'NORMAL', Platform: 'Ubuntu', Architecture: 'x86_64', Secret: 'must-not-escape' };

  beforeEach(() => {
    jest.clearAllMocks();
    getCredentials.mockResolvedValue(context);
    request.mockResolvedValue({ TotalCount: 1, ImageSet: [image] });
  });

  it('queries only the frozen account and region, returning a safe page without adopting resources', async () => {
    const result = await catalog.listImages(context.id, { scope: 'custom' });
    expect(getCredentials).toHaveBeenCalledWith(context.id, { requireReady: true });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ service: 'cvm', action: 'DescribeImages', regionId: 'ap-guangzhou', accessKeyId: 'fixture-id', parameters: { Filters: [{ Name: 'image-type', Values: ['PRIVATE_IMAGE'] }], Offset: 0, Limit: 20 } }));
    expect(result).toMatchObject({ provider: 'tencent_cloud', accountUid: context.accountUid, cloudAccountContextId: context.id, totalCount: 1, items: [{ imageId: image.ImageId, displayName: 'Ubuntu', isAvailable: true }] });
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|fixture-id|must-not-escape/);
  });

  it('never sends Alibaba credentials to Tencent', async () => {
    getCredentials.mockResolvedValue({ ...context, provider: 'alibaba_cloud' });
    await expect(catalog.listImages(context.id, { scope: 'public' })).rejects.toThrow(BadRequestException);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { TotalCount: 2, ImageSet: [image] },
    { TotalCount: 2, ImageSet: [image, image] },
    { TotalCount: 1, ImageSet: [{ ...image, ImageType: 'SHARED_IMAGE' }] },
    { TotalCount: 1, ImageSet: [{ ...image, ImageId: 'm-alibaba' }] },
    { TotalCount: 1, ImageSet: [{ ...image, ImageState: null }] },
    { TotalCount: '1', ImageSet: [image] },
  ])('rejects partial, duplicate or contradictory response %j', async (response) => {
    request.mockResolvedValue(response);
    await expect(catalog.listImages(context.id, { scope: 'custom' })).rejects.toThrow(BadGatewayException);
  });

  it('returns unavailable images honestly and forwards the requested page', async () => {
    request.mockResolvedValue({ TotalCount: 21, ImageSet: [{ ...image, ImageState: 'CREATING' }] });
    const result = await catalog.listImages(context.id, { scope: 'custom', offset: 20, limit: 20 });
    expect(result.items[0].isAvailable).toBe(false);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ Offset: 20, Limit: 20 }) }));
  });

  it.each([{ scope: 'shared' }, { scope: 'custom', limit: 101 }, { scope: 'custom', offset: -1 }])('rejects bad query before a cloud request', async (query) => {
    await expect(catalog.listImages(context.id, query as never)).rejects.toThrow(BadRequestException);
    expect(request).not.toHaveBeenCalled();
  });

  it('discovers only requested available regions in order, using the maintained CVM region API', async () => {
    request.mockResolvedValueOnce({ TotalCount: 3, RegionSet: [
      { Region: 'ap-nanjing', RegionName: '南京', RegionState: 'AVAILABLE' },
      { Region: 'ap-hangzhou', RegionName: '杭州', RegionState: 'UNAVAILABLE' },
      { Region: 'ap-guangzhou', RegionName: '广州', RegionState: 'AVAILABLE' },
    ] }).mockResolvedValueOnce({ TotalCount: 2, ZoneSet: [
      { Zone: 'ap-nanjing-1', ZoneName: '南京一区', ZoneState: 'AVAILABLE' },
      { Zone: 'ap-nanjing-2', ZoneName: '南京二区', ZoneState: 'UNAVAILABLE' },
    ] });
    const result = await catalog.discoverRegions({ regionIds: ['ap-hangzhou', 'ap-nanjing'], accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' });
    expect(result).toEqual({ provider: 'tencent_cloud', regions: [{ regionId: 'ap-nanjing', displayName: '南京', zones: [{ zoneId: 'ap-nanjing-1', displayName: '南京一区' }] }] });
    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({ service: 'region', version: '2022-06-27', action: 'DescribeRegions', parameters: { Product: 'cvm', Scene: 1 } }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'DescribeZones', regionId: 'ap-nanjing' }));
    expect(getCredentials).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });

  it('does not silently assume a region exists after an incomplete region response', async () => {
    request.mockResolvedValueOnce({ TotalCount: 2, RegionSet: [{ Region: 'ap-nanjing', RegionState: 'AVAILABLE' }] });
    await expect(catalog.discoverRegions({ regionIds: ['ap-nanjing'], accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' })).rejects.toThrow(BadGatewayException);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects zones from a different region', async () => {
    request.mockResolvedValueOnce({ TotalCount: 1, RegionSet: [{ Region: 'ap-nanjing', RegionState: 'AVAILABLE' }] })
      .mockResolvedValueOnce({ TotalCount: 1, ZoneSet: [{ Zone: 'ap-guangzhou-1', ZoneState: 'AVAILABLE' }] });
    await expect(catalog.discoverRegions({ regionIds: ['ap-nanjing'], accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' })).rejects.toThrow(BadGatewayException);
  });
});
