import type { PackedImageArtifactRecord } from '../src/admin/admin.repository';
import type { CloudAccountContextCredentials } from '../src/admin/cloud-account-contexts.service';
import { readAliyunPackedImageRejection } from '../src/admin/aliyun-packed-image-rejection';
import { AliyunImageRpcError } from '../src/admin/aliyun-image-rpc';
import { packedImageDiagnostic } from '../src/admin/packed-image-diagnostic';

const context = { id: 'context', provider: 'alibaba_cloud', accountUid: '123456', regionId: 'cn-beijing', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret' } as CloudAccountContextCredentials;
const artifact = { id: 'artifact', cloudProvider: 'alibaba_cloud', cloudAccountContextId: 'context', cloudAccountUid: '123456', regionId: 'cn-beijing',
  sourceInstanceId: 'i-original', imageId: null, sourceSnapshotId: null, platformImageAssetId: null, backingSnapshotIds: [], createdAt: new Date('2026-10-20T00:13:29Z') } as unknown as PackedImageArtifactRecord;
const event = { eventId: 'event-original', eventTime: '2026-10-20T00:13:30Z', eventName: 'CreateImage', serviceName: 'Ecs', eventType: 'ApiCall',
  recipientAccountId: '123456', acsRegion: 'cn-beijing', requestId: 'request-original', errorCode: 'InvalidImageName.Malformed',
  requestParameters: { ClientToken: 'artifact', InstanceId: 'i-original' } };

function dependencies(events: unknown[], options: { more?: boolean; denied?: boolean; failNextPage?: boolean } = {}) {
  return { now: () => new Date('2026-10-20T00:20:00Z'), pause: async () => undefined, fetch: jest.fn(async (input: unknown) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe('actiontrail.cn-beijing.aliyuncs.com');
    expect(url.searchParams.get('Action')).toBe('LookupEvents');
    expect(url.searchParams.get('LookupAttribute.1.Value')).toBe('CreateImage');
    return new Response(JSON.stringify({ StartTime: url.searchParams.get('StartTime'), EndTime: url.searchParams.get('EndTime'), RequestId: 'lookup-request',
      Events: events, ...(options.more ? { NextToken: 'next-page' } : {}) }), { status: options.denied || options.failNextPage && url.searchParams.has('NextToken') ? 403 : 200 });
  }) as unknown as typeof fetch };
}

describe('official rejection evidence for legacy Alibaba image submissions', () => {
  it('accepts an exact failed source/ClientToken event after validating the complete response', async () => {
    expect(await readAliyunPackedImageRejection(artifact, context, dependencies([event])))
      .toEqual({ phase: 'create_image', cloudErrorCode: 'InvalidImageName.Malformed', cloudRequestId: 'request-original' });
  });
  it.each([
    [], [{ ...event, errorCode: undefined }], [{ ...event, errorCode: 'InternalError' }],
    [{ ...event, recipientAccountId: 'foreign' }], [{ ...event, acsRegion: 'cn-shanghai' }],
    [{ ...event, requestParameters: { ClientToken: 'artifact', InstanceId: 'i-foreign' } }],
    [{ ...event, requestParameters: { ClientToken: 'foreign', InstanceId: 'i-original' } }],
    [{ ...event, responseElements: { ImageId: 'm-already-created' } }],
    [{ ...event, requestId: 'synthetic-secret' }], [event, event], [event, { ...event, eventId: 'other-event', errorCode: undefined }],
  ].map(events => ({ events: events as unknown[] })))('does not infer failure from absent, conflicting or successful evidence: %#', async ({ events }) => {
    expect(await readAliyunPackedImageRejection(artifact, context, dependencies(events))).toBeNull();
  });
  it('does not use a first-page rejection when pagination fails or repeats', async () => {
    expect(await readAliyunPackedImageRejection(artifact, context, dependencies([event], { more: true, failNextPage: true }))).toBeNull();
    expect(await readAliyunPackedImageRejection(artifact, context, dependencies([event], { more: true }))).toBeNull();
  });
  it('keeps unknown on denied audit permission and rejects a different frozen account before querying', async () => {
    expect(await readAliyunPackedImageRejection(artifact, context, dependencies([event], { denied: true }))).toBeNull();
    const deps = dependencies([event]);
    expect(await readAliyunPackedImageRejection(artifact, { ...context, accountUid: 'foreign' }, deps)).toBeNull();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('retains bounded Alibaba cloud codes and request receipts, never raw messages or credential values', () => {
    expect(packedImageDiagnostic(new AliyunImageRpcError('CreateImage', 'Forbidden.RAM', 403, 'request-original'), 'create_image'))
      .toEqual({ phase: 'create_image', cloudErrorCode: 'Forbidden.RAM', cloudRequestId: 'request-original' });
    expect(packedImageDiagnostic(new AliyunImageRpcError('CreateImage', 'synthetic-secret', 400, 'synthetic-secret'), 'create_image', ['synthetic-secret']))
      .toEqual({ phase: 'create_image', cloudErrorCode: 'UNKNOWN' });
  });
});
