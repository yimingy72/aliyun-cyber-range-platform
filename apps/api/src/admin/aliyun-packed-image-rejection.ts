import { randomUUID } from 'node:crypto';
import type { PackedImageArtifactRecord } from './admin.repository';
import type { CloudAccountContextCredentials } from './cloud-account-contexts.service';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { isAliyunImageSubmissionRejection } from './aliyun-image-rpc';
import { Logger } from '@nestjs/common';
import { sanitizeAliyunErrorCode } from './aliyun-error-code';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const receipt = (value: unknown) => /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(text(value));
const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
type Rejection = { phase: 'create_image'; cloudErrorCode: string; cloudRequestId: string };
const logger = new Logger('PackedImageRejectionAudit');

// A missing current image is not rejection proof. Legacy UNKNOWN submissions require an
// official failed CreateImage event bound to their original ClientToken, source and account.
export async function readAliyunPackedImageRejection(artifact: PackedImageArtifactRecord, context: CloudAccountContextCredentials,
  dependencies: { fetch?: typeof fetch; pause?: () => Promise<void>; now?: () => Date;
    onUnavailable?: (diagnostic: { phase: 'rejection_audit'; cloudErrorCode: string; cloudRequestId?: string }) => void } = {}): Promise<Rejection | null> {
  try {
    if ((artifact.cloudProvider ?? 'alibaba_cloud') !== 'alibaba_cloud' || context.provider !== 'alibaba_cloud'
      || artifact.cloudAccountContextId !== context.id || artifact.cloudAccountUid !== context.accountUid || artifact.regionId !== context.regionId
      || artifact.imageId || artifact.platformImageAssetId || artifact.backingSnapshotIds.length || artifact.sourceSnapshotId) return null;
    const now = (dependencies.now ?? (() => new Date()))();
    if (now.getTime() < artifact.createdAt.getTime() || now.getTime() - artifact.createdAt.getTime() > 89 * 86_400_000) return null;
    const startAt = iso(new Date(artifact.createdAt.getTime() - 1000));
    const endAt = iso(new Date(Math.min(now.getTime(), artifact.createdAt.getTime() + 10 * 60_000)));
    const seenTokens = new Set<string>(), seenEvents = new Set<string>();
    const matched: Rejection[] = [];
    let nextToken = '';
    for (let page = 0; page < 100; page++) {
      await (dependencies.pause ?? (() => new Promise(resolve => setTimeout(resolve, 550))))();
      const query = signAliyunRpcQuery({ Action: 'LookupEvents', AccessKeyId: context.accessKeyId, Format: 'JSON', RegionId: context.regionId,
        SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(), SignatureVersion: '1.0', Timestamp: iso(now), Version: '2020-07-06',
        StartTime: startAt, EndTime: endAt, MaxResults: '50', Direction: 'FORWARD',
        'LookupAttribute.1.Key': 'EventName', 'LookupAttribute.1.Value': 'CreateImage', ...(nextToken ? { NextToken: nextToken } : {}) }, context.accessKeySecret);
      const response = await (dependencies.fetch ?? fetch)(`https://actiontrail.${context.regionId}.aliyuncs.com/?${query}`, { signal: AbortSignal.timeout(30_000) });
      const body: unknown = await response.json();
      if (!response.ok || object(body) && body.Code != null && body.Code !== 'Success') {
        const secrets = [context.accessKeyId, context.accessKeySecret].filter(Boolean);
        const requestId = object(body) && receipt(body.RequestId) && !secrets.some(secret => text(body.RequestId).includes(secret)) ? text(body.RequestId) : undefined;
        logger.warn(JSON.stringify({ event: 'packed_image_audit_unavailable', packedImageArtifactId: artifact.id,
          cloudErrorCode: object(body) ? sanitizeAliyunErrorCode(body.Code, secrets) : null, cloudRequestId: requestId }));
        dependencies.onUnavailable?.({ phase: 'rejection_audit', cloudErrorCode: object(body) ? sanitizeAliyunErrorCode(body.Code, secrets) || 'AuditUnavailable' : 'AuditUnavailable', cloudRequestId: requestId });
        return null;
      }
      if (!response.ok || !object(body) || body.Code != null && body.Code !== 'Success' || !receipt(body.RequestId)
        || body.StartTime !== startAt || body.EndTime !== endAt || !Array.isArray(body.Events) || body.Events.length > 50
        || body.NextToken != null && typeof body.NextToken !== 'string') return null;
      for (const event of body.Events) {
        if (!object(event) || !receipt(event.eventId) || seenEvents.has(text(event.eventId))) return null;
        seenEvents.add(text(event.eventId));
        let parameters = event.requestParameters;
        if (parameters == null && typeof event.requestParameterJson === 'string') parameters = JSON.parse(event.requestParameterJson);
        if (!object(parameters)) return null;
        const clientToken = parameters.ClientToken ?? parameters.clientToken;
        if (clientToken !== artifact.id) continue;
        const owner = event.recipientAccountId ?? (object(event.userIdentity) ? event.userIdentity.accountId : null);
        const eventTime = Date.parse(text(event.eventTime));
        if (owner !== artifact.cloudAccountUid || event.acsRegion !== artifact.regionId || event.serviceName !== 'Ecs'
          || event.eventName !== 'CreateImage' || event.eventType !== 'ApiCall' || event.eventCategory != null && event.eventCategory !== 'Management'
          || !Number.isFinite(eventTime) || eventTime < Date.parse(startAt) || eventTime > Date.parse(endAt)
          || (parameters.InstanceId ?? parameters.instanceId) !== artifact.sourceInstanceId
          || !isAliyunImageSubmissionRejection(text(event.errorCode)) || !receipt(event.requestId)
          || object(event.responseElements) && Boolean(event.responseElements.ImageId ?? event.responseElements.imageId)) return null;
        const cloudErrorCode = text(event.errorCode), cloudRequestId = text(event.requestId);
        if ([context.accessKeyId, context.accessKeySecret].filter(Boolean).some(secret => cloudErrorCode.includes(secret) || cloudRequestId.includes(secret))) return null;
        matched.push({ phase: 'create_image', cloudErrorCode, cloudRequestId });
      }
      nextToken = text(body.NextToken);
      if (!nextToken) return matched.length === 1 ? matched[0] : null;
      if (!body.Events.length || seenTokens.has(nextToken)) return null;
      seenTokens.add(nextToken);
    }
    return null;
  } catch { dependencies.onUnavailable?.({ phase: 'rejection_audit', cloudErrorCode: 'AuditUnavailable' }); return null; }
}
