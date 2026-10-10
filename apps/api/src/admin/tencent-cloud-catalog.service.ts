import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';

import { CloudAccountContextsService } from './cloud-account-contexts.service';
import type { TencentCloudCatalogQueryDto, TencentCloudRegionsQueryDto } from './dto/tencent-cloud-catalog.dto';
import { requestTencentCloud, TencentCloudRequestError, type TencentCloudRequest } from './tencent-cloud-client';

type TencentImage = {
  ImageId: string;
  ImageName: string;
  ImageType: string;
  ImageState: string;
  Platform?: string;
  Architecture?: string;
};

@Injectable()
export class TencentCloudCatalogService {
  constructor(private readonly cloudContexts: CloudAccountContextsService) {}

  async discoverRegions(input: TencentCloudRegionsQueryDto) {
    if (!Array.isArray(input.regionIds) || input.regionIds.length < 1 || input.regionIds.length > 3
      || new Set(input.regionIds).size !== input.regionIds.length
      || input.regionIds.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(id))) {
      throw new BadRequestException('请指定最多三个待查询的腾讯云地域。');
    }
    const credentials = { accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret };
    const response = await this.request<{ TotalCount: number; RegionSet: Array<{ Region: string; RegionName?: string; RegionState: string }> }>({
      ...credentials, service: 'region', version: '2022-06-27', action: 'DescribeRegions', parameters: { Product: 'cvm', Scene: 1 },
    });
    if (!Array.isArray(response.RegionSet) || response.TotalCount !== response.RegionSet.length
      || new Set(response.RegionSet.map(item => item?.Region)).size !== response.RegionSet.length
      || response.RegionSet.some(item => !item || typeof item.Region !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(item.Region)
        || typeof item.RegionState !== 'string' || (item.RegionName !== undefined && typeof item.RegionName !== 'string'))) {
      throw new BadGatewayException('腾讯云地域响应不完整，请重试查询。');
    }
    const regions = [];
    for (const regionId of input.regionIds) {
      const region = response.RegionSet.find(item => item.Region === regionId && item.RegionState === 'AVAILABLE');
      if (!region) continue;
      const zones = await this.request<{ TotalCount: number; ZoneSet: Array<{ Zone: string; ZoneName?: string; ZoneState: string }> }>({
        ...credentials, service: 'region', version: '2022-06-27', action: 'DescribeZones', regionId, parameters: { Product: 'cvm', Scene: 1 },
      });
      if (!Array.isArray(zones.ZoneSet) || zones.TotalCount !== zones.ZoneSet.length
        || new Set(zones.ZoneSet.map(item => item?.Zone)).size !== zones.ZoneSet.length
        || zones.ZoneSet.some(item => !item || typeof item.Zone !== 'string' || !item.Zone.startsWith(`${regionId}-`)
          || typeof item.ZoneState !== 'string' || (item.ZoneName !== undefined && typeof item.ZoneName !== 'string'))) {
        throw new BadGatewayException('腾讯云可用区响应不完整，请重试查询。');
      }
      regions.push({ regionId, displayName: region.RegionName ?? regionId, zones: zones.ZoneSet
        .filter(zone => zone.ZoneState === 'AVAILABLE' && /^\d+$/.test(zone.Zone.slice(regionId.length + 1)))
        .map(zone => ({ zoneId: zone.Zone, displayName: zone.ZoneName ?? zone.Zone })) });
    }
    return { provider: 'tencent_cloud' as const, regions };
  }

  async listImages(contextId: string, query: TencentCloudCatalogQueryDto) {
    const context = await this.cloudContexts.getCredentials(contextId, { requireReady: true });
    if (context.provider !== 'tencent_cloud') {
      throw new BadRequestException('请选择腾讯云账号查询镜像。');
    }
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 20;
    if (!['public', 'custom'].includes(query.scope) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('镜像查询参数无效。');
    }
    const imageType = query.scope === 'public' ? 'PUBLIC_IMAGE' : 'PRIVATE_IMAGE';
    const response = await this.request<{ TotalCount: number; ImageSet: TencentImage[] }>({
      service: 'cvm', version: '2017-03-12', action: 'DescribeImages', regionId: context.regionId,
      accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret,
      parameters: { Filters: [{ Name: 'image-type', Values: [imageType] }], Offset: offset, Limit: limit },
    });
    if (!Number.isSafeInteger(response.TotalCount) || response.TotalCount < 0 || !Array.isArray(response.ImageSet)
      || response.ImageSet.length > limit || (offset < response.TotalCount && response.ImageSet.length !== Math.min(limit, response.TotalCount - offset))
      || (offset >= response.TotalCount && response.ImageSet.length !== 0)) {
      throw new BadGatewayException('腾讯云镜像分页响应不完整，请重试查询。');
    }
    const imageIds = new Set<string>();
    const items = response.ImageSet.map((image) => {
      if (!image || typeof image !== 'object' || typeof image.ImageId !== 'string' || !/^img-[a-z0-9]+$/.test(image.ImageId)
        || typeof image.ImageName !== 'string' || !image.ImageName.trim() || image.ImageType !== imageType
        || typeof image.ImageState !== 'string' || !image.ImageState.trim() || imageIds.has(image.ImageId)
        || (image.Platform !== undefined && typeof image.Platform !== 'string')
        || (image.Architecture !== undefined && typeof image.Architecture !== 'string')) {
        throw new BadGatewayException('腾讯云镜像响应无效，请重试查询。');
      }
      imageIds.add(image.ImageId);
      return {
        imageId: image.ImageId, displayName: image.ImageName, status: image.ImageState,
        platform: image.Platform ?? null, architecture: image.Architecture ?? null,
        isAvailable: image.ImageState === 'NORMAL',
      };
    });
    // Querying an external image is not evidence that the platform created it or owns its costs.
    return {
      provider: 'tencent_cloud' as const, cloudAccountContextId: context.id, accountUid: context.accountUid,
      regionId: context.regionId, zoneId: context.zoneId, scope: query.scope,
      offset, limit, totalCount: response.TotalCount, items,
    };
  }

  private async request<T>(input: TencentCloudRequest): Promise<T> {
    try { return await requestTencentCloud<T>(input); }
    catch (error) {
      throw new BadGatewayException(error instanceof TencentCloudRequestError ? error.message : '腾讯云查询暂不可用，请稍后重试。');
    }
  }
}
