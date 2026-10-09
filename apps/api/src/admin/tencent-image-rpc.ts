import { BadGatewayException } from '@nestjs/common';
import type { CloudAccountContextCredentials } from './cloud-account-contexts.service';
import { requestTencentCloud } from './tencent-cloud-client';

export type TencentImageCredentials = Pick<CloudAccountContextCredentials, 'provider' | 'accountUid' | 'regionId' | 'accessKeyId' | 'accessKeySecret'> & { id?: string };
export type TencentImage = { CloudProvider: 'tencent_cloud'; ImageSize: number | null; ImageId: string; ImageName: string; Status: string; OSType: string; Platform: string; Architecture: string; Progress: string;
  ImageType: string; CreatedTime: string; Tags: { Tag: Array<{ TagKey: string; TagValue: string }> };
  DiskDeviceMappings: { DiskDeviceMapping: Array<{ SnapshotId: string; DiskUsage: string }> } };
export type TencentSnapshot = { SnapshotId: string; SourceDiskId: string; SourceSnapshotId?: string; RegionId: string; CreationTime: string; Usage: string;
  SnapshotType: string; SnapshotState: string; ShareReference: number; CopyFromRemote: boolean; ImageIds: string[]; Tags: TencentImage['Tags'] };
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadGatewayException('腾讯云镜像响应对象不完整。');
  return value as Record<string, unknown>;
}
function text(value: unknown) { return typeof value === 'string' ? value : ''; }
function identity(value: unknown, prefix: string) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}-[A-Za-z0-9]+$`).test(value)) throw new BadGatewayException('腾讯云镜像资源身份不完整。');
  return value;
}
function tags(value: unknown) {
  if (value === null || value === undefined) return { Tag: [] };
  if (!Array.isArray(value)) throw new BadGatewayException('腾讯云镜像标签格式不完整。');
  const result = value.map(raw => { const row = obj(raw); if (typeof row.Key !== 'string' || !row.Key || typeof row.Value !== 'string') throw new BadGatewayException('腾讯云镜像标签格式不完整。');
    return { TagKey: row.Key, TagValue: row.Value }; });
  if (new Set(result.map(tag => tag.TagKey)).size !== result.length) throw new BadGatewayException('腾讯云镜像标签重复。');
  return { Tag: result };
}
function assertContext(context: TencentImageCredentials) {
  if (context.provider !== 'tencent_cloud' || !context.accountUid || !context.regionId || !context.accessKeyId || !context.accessKeySecret) throw new BadGatewayException('腾讯云镜像操作缺少冻结厂商、UID 或地域。');
}
export function tencentImageRequest<T>(context: TencentImageCredentials, service: 'cvm' | 'cbs' | 'tag', action: string, parameters: Record<string, unknown> = {}) {
  assertContext(context);
  return requestTencentCloud<T>({ service, action, version: service === 'tag' ? '2018-08-13' : '2017-03-12', regionId: context.regionId,
    accessKeyId: context.accessKeyId, accessKeySecret: context.accessKeySecret, parameters });
}
async function pages(context: TencentImageCredentials, service: 'cvm' | 'cbs', action: string, set: string, parameters: Record<string, unknown>) {
  const result: Record<string, unknown>[] = []; let expected: number | undefined;
  for (let page = 0; page < 100; page++) {
    const body = obj(await tencentImageRequest(context, service, action, { ...parameters, Offset: result.length, Limit: 100 }));
    const rows = body[set];
    if (!body.RequestId || !Number.isSafeInteger(body.TotalCount) || Number(body.TotalCount) < 0 || !Array.isArray(rows) || rows.length > 100
      || body.Error || body.NextToken || expected !== undefined && expected !== body.TotalCount) throw new BadGatewayException('腾讯云镜像查询分页不完整或总数变化。');
    expected = Number(body.TotalCount); result.push(...rows.map(obj));
    if (result.length === expected) return result;
    if (!rows.length || result.length > expected) throw new BadGatewayException('腾讯云镜像查询缺页。');
  }
  throw new BadGatewayException('腾讯云镜像查询超出分页上限。');
}
export async function describeTencentImages(context: TencentImageCredentials, input: { ImageId?: string; SnapshotId?: string; tags?: Record<string, string>;
  scope?: 'public' | 'custom' } = {}): Promise<TencentImage[]> {
  assertContext(context);
  if (input.ImageId && (input.SnapshotId || input.tags || input.scope)) throw new BadGatewayException('镜像已知 ID 与过滤器不能混用。');
  const filters = [{ Name: 'image-type', Values: [input.scope === 'public' ? 'PUBLIC_IMAGE' : 'PRIVATE_IMAGE'] },
    ...Object.entries(input.tags ?? {}).map(([key, value]) => ({ Name: `tag:${key}`, Values: [value] }))];
  if (filters.length > 10) throw new BadGatewayException('腾讯云镜像过滤器超过限制。');
  if (input.SnapshotId) identity(input.SnapshotId, 'snap');
  const rows = await pages(context, 'cvm', 'DescribeImages', 'ImageSet', input.ImageId ? { ImageIds: [identity(input.ImageId, 'img')] } : { Filters: filters });
  const images = rows.map(row => {
    const id = identity(row.ImageId, 'img');
    if (!text(row.ImageState) || input.ImageId && input.ImageId !== id || !input.ImageId && row.ImageType !== filters[0].Values[0]) throw new BadGatewayException('腾讯云镜像查询返回非请求身份或状态。');
    if (row.SnapshotSet !== null && row.SnapshotSet !== undefined && !Array.isArray(row.SnapshotSet)) throw new BadGatewayException('腾讯云镜像快照绑定格式不完整。');
    const mappings = ((row.SnapshotSet ?? []) as unknown[]).map(value => { const snapshot = obj(value); return { SnapshotId: identity(snapshot.SnapshotId, 'snap'), DiskUsage: text(snapshot.DiskUsage) }; });
    if (new Set(mappings.map(mapping => mapping.SnapshotId)).size !== mappings.length) throw new BadGatewayException('腾讯云镜像快照绑定重复。');
    const normalizedTags = tags(row.Tags), tagValues = Object.fromEntries(normalizedTags.Tag.map(tag => [tag.TagKey, tag.TagValue]));
    if (Object.entries(input.tags ?? {}).some(([key, value]) => tagValues[key] !== value)) throw new BadGatewayException('腾讯云镜像标签查询不匹配。');
    return { CloudProvider: 'tencent_cloud' as const, ImageSize: Number.isSafeInteger(row.ImageSize) && Number(row.ImageSize) > 0 ? Number(row.ImageSize) : null, ImageId: id, ImageName: text(row.ImageName), Status: row.ImageState === 'NORMAL' ? 'Available' : /FAILED|ERROR/.test(text(row.ImageState)) ? 'Failed' : text(row.ImageState),
      OSType: /windows/i.test(`${text(row.OsName)} ${text(row.Platform)}`) ? 'windows' : 'linux', Platform: text(row.Platform), Architecture: text(row.Architecture),
      Progress: Number.isFinite(row.SyncPercent) ? `${row.SyncPercent}%` : '', ImageType: text(row.ImageType), CreatedTime: text(row.CreatedTime), Tags: normalizedTags, DiskDeviceMappings: { DiskDeviceMapping: mappings } };
  });
  if (new Set(images.map(image => image.ImageId)).size !== images.length) throw new BadGatewayException('腾讯云镜像查询返回重复身份。');
  // DescribeImages has no snapshot filter. Read the complete private set before matching; never guess an undocumented filter.
  return input.SnapshotId ? images.filter(image => image.DiskDeviceMappings.DiskDeviceMapping.some(mapping => mapping.SnapshotId === input.SnapshotId)) : images;
}
export async function describeTencentSnapshot(context: TencentImageCredentials, snapshotId: string): Promise<TencentSnapshot | null> {
  const rows = await pages(context, 'cbs', 'DescribeSnapshots', 'SnapshotSet', { SnapshotIds: [identity(snapshotId, 'snap')] });
  if (rows.length > 1 || rows.some(row => row.SnapshotId !== snapshotId)) throw new BadGatewayException('腾讯云快照身份不唯一。');
  if (!rows.length) return null;
  const row = rows[0];
  if (!Array.isArray(row.Images) || !Number.isSafeInteger(row.ShareReference) || Number(row.ShareReference) < 0 || typeof row.CopyFromRemote !== 'boolean'
    || typeof row.SnapshotType !== 'string' || typeof row.SnapshotState !== 'string' || !text(row.CreateTime)) throw new BadGatewayException('腾讯云快照来源或共享信息不完整。');
  const imageIds = row.Images.map(value => identity(obj(value).ImageId, 'img'));
  return { SnapshotId: snapshotId, SourceDiskId: text(row.DiskId), RegionId: context.regionId, CreationTime: text(row.CreateTime),
    SourceSnapshotId: row.CopyFromRemote ? 'copied' : undefined, Usage: imageIds.length ? 'image' : '', SnapshotType: row.SnapshotType,
    SnapshotState: row.SnapshotState, ShareReference: Number(row.ShareReference), CopyFromRemote: row.CopyFromRemote,
    ImageIds: imageIds, Tags: tags(row.Tags) };
}
export async function tagTencentImageResources(context: TencentImageCredentials, type: 'image' | 'snapshot', ids: string[], values: Record<string, string>) {
  const entries = Object.entries(values);
  for (let offset = 0; offset < ids.length; offset += 10) {
    for (let tagOffset = 0; tagOffset < entries.length; tagOffset += 10) {
    const result = obj(await tencentImageRequest(context, 'tag', 'TagResources', {
      ResourceList: ids.slice(offset, offset + 10).map(id => `qcs::${type === 'image' ? 'cvm' : 'cbs'}:${context.regionId}:uin/${context.accountUid}:${type}/${identity(id, type === 'image' ? 'img' : 'snap')}`),
      Tags: entries.slice(tagOffset, tagOffset + 10).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) }));
    if (!Array.isArray(result.FailedResources) || result.FailedResources.length) throw new BadGatewayException('腾讯云资源标签操作存在失败或不完整结果；费用身份已保留。');
    }
  }
}
export async function deleteTencentImage(context: TencentImageCredentials, imageId: string) {
  return tencentImageRequest(context, 'cvm', 'DeleteImages', { ImageIds: [identity(imageId, 'img')], DeleteBindedSnap: false });
}
export async function deleteTencentSnapshot(context: TencentImageCredentials, snapshotId: string) {
  const snapshot = await describeTencentSnapshot(context, snapshotId);
  if (!snapshot) return;
  if (snapshot.CopyFromRemote || snapshot.SnapshotType !== 'PRIVATE_SNAPSHOT' || snapshot.ShareReference !== 0 || snapshot.ImageIds.length
    || snapshot.SnapshotState !== 'NORMAL' || (await describeTencentImages(context, { SnapshotId: snapshotId })).length) throw new BadGatewayException('腾讯云快照仍有共享、镜像或其它使用状态，拒绝强制删除。');
  return tencentImageRequest(context, 'cbs', 'DeleteSnapshots', { SnapshotIds: [snapshotId], DeleteBindImages: false });
}
