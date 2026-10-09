import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository, RangeInstanceRecord } from './admin.repository';
import { buildAliyunTagParameters, buildBillingTags } from './billing-tagging';
import type { SessionUserProfile } from './admin-user-auth';
import { generateAliyunEcsPassword } from './ecs-password-generator';
import { PackedImagesService } from './packed-images.service';
import { imageRpc } from './aliyun-image-rpc';
import { describeTencentInstances, assertTencentOwnedInstance } from './tencent-cloud-resources';
import { requestTencentCloud } from './tencent-cloud-client';
import { encryptPlatformImageDefaultPassword } from './platform-image-password';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';

const ALICLOUD_VNC_CONSOLE_URL = 'https://g.alicdn.com/aliyun/ecs-console-vnc2/0.0.8/index.html';

type NodeActionName = 'start' | 'stop' | 'reboot' | 'open-vnc' | 'pack-image';
type AuthenticatedUser = Pick<SessionUserProfile, 'id' | 'role'>;

@Injectable()
export class RangeInstanceNodeActionsService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
    private readonly packedImages: PackedImagesService,
  ) {}

  async run(
    rangeInstanceId: string,
    nodeId: string,
    action: string,
    payload: Record<string, string>,
    currentUser?: AuthenticatedUser,
    boundAccountContext?: SystemCloudAccountContext,
  ) {
    const instance = await this.adminRepository.getRangeInstanceById(rangeInstanceId);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (currentUser && currentUser.role !== 'admin' && instance.ownerUserId !== currentUser.id) {
      throw new ForbiddenException('Range instance access denied');
    }
    if (!['alibaba_cloud', 'tencent_cloud'].includes(instance.cloudProvider)) throw new ConflictException('该云厂商的节点控制与镜像打包尚未开放。');

    if (!isNodeActionName(action)) {
      throw new NotFoundException('Unsupported node action');
    }

    if (instance.instanceMode === 'range') {
      if (instance.status !== 'running') throw new ConflictException('Only running ranges can control nodes');
      const activeOperation = (await this.adminRepository.listProvisionJobs()).some(job =>
        job.rangeInstanceId === instance.id && ['pending', 'running'].includes(job.status));
      if (activeOperation) throw new ConflictException('Range instance has an active operation');
    }

    if (instance.instanceMode === 'single' && instance.singleInstanceConfig?.executionBackend === 'opentofu' && action !== 'open-vnc') {
      const job = instance.lastJobId ? await this.adminRepository.getProvisionJobById(instance.lastJobId) : null;
      if (job && ['create', 'retry'].includes(job.jobType) && ['pending', 'running'].includes(job.status)) {
        throw new ConflictException('实例仍在完成创建，请等待创建任务结束后操作。');
      }
    }

    if (instance.resourceSummary?.mode === 'dry-run') {
      throw new ConflictException(
        '此实例以 dry-run 模式创建，未下发阿里云 ECS 或网络资源；请切换到 opentofu 后重新创建实例再执行节点操作。',
      );
    }

    const hostInstanceId = this.resolveHostInstanceId(instance, nodeId);
    const hostNode = this.resolveHostTopologyNode(instance, nodeId);
    const source = instance.instanceMode === 'single' ? instance.singleInstanceConfig : instance.resourceSummary?.executionContext;
    if (instance.cloudProvider === 'tencent_cloud' && (!source?.cloudAccountContextId || !source.cloudAccountUid || !source.regionId))
      throw new ConflictException('腾讯云节点操作需要已冻结并核验的原云账号。');
    const accountContext = boundAccountContext ?? (source?.cloudAccountContextId
      ? await this.systemConfigService.getAccountContextById(source.cloudAccountContextId)
      : await this.systemConfigService.getAccountContext());
    if (accountContext.provider !== instance.cloudProvider) throw new ConflictException('云账号厂商与当前节点执行器不符。');
    if (source?.cloudAccountContextId && (source.cloudAccountContextId !== accountContext.cloudAccountContextId
      || source.cloudAccountUid !== accountContext.accountUid || source.regionId !== accountContext.defaultRegion || !accountContext.accountUidResolved))
      throw new ConflictException('实例云账号与创建时绑定不符。');
    if (accountContext.provider === 'tencent_cloud' && action !== 'pack-image') return this.runTencentNodeAction(instance, nodeId, hostInstanceId, action, accountContext);


    if (action === 'start') {
      const response = await this.performAliyunRpcRequest({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        action: 'StartInstance',
        parameters: {
          InstanceId: hostInstanceId,
        },
      });

      return { status: 'accepted', action, response };
    }

    if (action === 'stop') {
      const response = await this.performAliyunRpcRequest({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        action: 'StopInstance',
        parameters: {
          InstanceId: hostInstanceId,
          ForceStop: 'true',
        },
      });

      return { status: 'accepted', action, response };
    }

    if (action === 'reboot') {
      const response = await this.performAliyunRpcRequest({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        action: 'RebootInstance',
        parameters: {
          InstanceId: hostInstanceId,
          ForceStop: 'true',
        },
      });

      return { status: 'accepted', action, response };
    }

    if (action === 'open-vnc') {
      const response = await this.performAliyunRpcRequest<{
        VncUrl?: string;
      }>({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
        action: 'DescribeInstanceVncUrl',
        parameters: {
          InstanceId: hostInstanceId,
        },
      });

      const vncUrl = response.VncUrl?.trim() || null;
      const webTerminalUrl = vncUrl
        ? await this.buildAliyunVncConsoleUrl(instance, nodeId, hostInstanceId, vncUrl)
        : null;

      return {
        status: 'accepted',
        action,
        vncUrl,
        webTerminalUrl,
      };
    }

    const displayName = payload.displayName?.trim() || `${nodeId}-snapshot`;
    const defaultHostName = payload.defaultHostName?.trim() || readHostName(hostNode, nodeId);
    const defaultPassword = payload.defaultPassword?.trim() || generateAliyunEcsPassword();
    const description = payload.description?.trim() || null;
    const ownerUserId = instance.ownerUserId ?? instance.createdBy;
    if (!ownerUserId || !accountContext.accountUid || !accountContext.cloudAccountContextId) throw new ConflictException('打包需要明确 owner 和已验证云账号。');
    const artifact = await this.packedImages.begin({ cloudAccountContextId: accountContext.cloudAccountContextId, cloudAccountUid: accountContext.accountUid, regionId: accountContext.defaultRegion, ownerUserId, sourceRangeInstanceId: rangeInstanceId, sourceHostKey: nodeId, sourceInstanceId: hostInstanceId }, {
      id: accountContext.cloudAccountContextId, provider: accountContext.provider, accountUid: accountContext.accountUid, regionId: accountContext.defaultRegion, zoneId: accountContext.defaultZoneId, accessKeyId: accountContext.accessKeyId, accessKeySecret: accountContext.accessKeySecret, imageImportBucket: accountContext.imageImportBucket, status: 'ready',
    });
    try {
      const createImageResponse = accountContext.provider === 'tencent_cloud'
        ? await this.packedImages.submitTencentImage(artifact, { id: accountContext.cloudAccountContextId, provider: 'tencent_cloud', accountUid: accountContext.accountUid, regionId: accountContext.defaultRegion, zoneId: accountContext.defaultZoneId, accessKeyId: accountContext.accessKeyId, accessKeySecret: accountContext.accessKeySecret, imageImportBucket: accountContext.imageImportBucket, status: 'ready' }, { name: displayName, description })
        : await this.performAliyunRpcRequest<{
        ImageId?: string;
      }>({
        accessKeyId: accountContext.accessKeyId,
        accessKeySecret: accountContext.accessKeySecret,
        regionId: accountContext.defaultRegion,
          action: 'CreateImage',
          parameters: {
            InstanceId: hostInstanceId,
            ImageName: displayName,
            ClientToken: artifact.id,
            ...(description ? { Description: description } : {}),
            ...buildAliyunTagParameters(
              buildBillingTags({
                billingScope: ownerUserId ? 'user' : 'platform',
                ownerUserId,
                rangeInstanceId,
                singleInstanceBatchId: instance.singleInstanceBatchId,
                platformResourceType: 'image',
                platformPackedImageArtifactId: artifact.id,
                platformHostKey: nodeId,
                billingStartAt: new Date(),
              }),
            ),
          },
        });

      const imageId = createImageResponse.ImageId?.trim();

      if (!imageId) {
        throw new Error('Aliyun CreateImage response is missing ImageId');
      }

      await this.packedImages.updateClaimed(artifact.id, artifact.submissionToken, { imageId, status: 'creating' });
      const { platformImageAsset, snapshot } = await this.adminRepository.withPackedImageArtifactClaim(artifact.id, artifact.submissionToken, async claimed => {
        const syncedAt = new Date();
        await claimed.upsertImageSnapshots({
          provider: accountContext.provider,
          accountUid: accountContext.accountUid,
          regionId: accountContext.defaultRegion,
          scope: 'custom',
          snapshots: [
            {
              imageId,
              sourceImageName: displayName,
              status: 'Creating',
              isAvailable: false,
              lastSyncedAt: syncedAt,
            },
          ],
      });

      const snapshot = (await claimed.listImageSnapshots({
        provider: accountContext.provider,
        accountUid: accountContext.accountUid,
        regionId: accountContext.defaultRegion,
        scope: 'custom',
        imageId,
      }))[0];

      if (!snapshot) {
        throw new Error('Image snapshot was not persisted after CreateImage');
      }

      const platformImageAsset = await claimed.collectPlatformImageAsset({
        snapshotId: snapshot.id,
        displayName,
        defaultHostName,
        defaultPassword: encryptPlatformImageDefaultPassword(defaultPassword),
        description,
        ownerUserId,
        visibility: 'private',
      });
      const disabledAsset = await claimed.setPlatformImageAssetEnabled(platformImageAsset.id, false);
      await claimed.updatePackedImageArtifact(artifact.id, { imageId, sourceSnapshotId: snapshot.id, platformImageAssetId: platformImageAsset.id, status: 'creating' });
      await this.packedImages.upsertLedger((await claimed.getPackedImageArtifact(artifact.id))!, imageId, 'image', undefined, claimed);

      return { platformImageAsset: disabledAsset, snapshot };
      });

      return {
        status: 'accepted',
        packedImageArtifactId: artifact.id,
        action,
        imageId,
        defaultHostName,
        defaultPassword,
        description,
        imageReady: snapshot.isAvailable,
        platformImageAsset,
      };
    } catch {
      await this.packedImages.updateClaimed(artifact.id, artifact.submissionToken, { errorMessage: '打包提交结果未完整确认，来源材料已保留，worker 会按唯一标签核验。' });
      throw new BadGatewayException({ message: '打包结果未完整确认，请按来源记录核验；不要重复提交或删除恢复材料。', packedImageArtifactId: artifact.id });
    } finally {
      await this.packedImages.endSubmission(artifact.id, artifact.submissionToken);
    }
  }

  private async runTencentNodeAction(instance: RangeInstanceRecord, nodeId: string, instanceId: string, action: NodeActionName, account: SystemCloudAccountContext) {
    if (action === 'pack-image') throw new ConflictException('腾讯云镜像打包需由已绑定来源的镜像服务执行。');
    const [detail] = await describeTencentInstances(account, { instanceIds: [instanceId] });
    if (!detail) throw new NotFoundException('Tencent CVM node was not found');
    assertTencentOwnedInstance(instance, account, detail, nodeId);
    if (action === 'start' && detail.status !== 'Stopped' || ['stop', 'reboot'].includes(action) && detail.status !== 'Running')
      throw new ConflictException('腾讯云节点当前状态不允许此操作。');
    const cloudAction = { start: 'StartInstances', stop: 'StopInstances', reboot: 'RebootInstances', 'open-vnc': 'DescribeInstanceVncUrl' }[action];
    const response = await requestTencentCloud<{ RequestId: string; InstanceVncUrl?: string }>({ service: 'cvm', version: '2017-03-12', action: cloudAction,
      regionId: account.defaultRegion, accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret,
      parameters: action === 'open-vnc' ? { InstanceId: instanceId } : { InstanceIds: [instanceId],
        ...(action === 'stop' || action === 'reboot' ? { StopType: 'SOFT' } : {}), ...(action === 'stop' ? { StoppedMode: 'KEEP_CHARGING' } : {}) } });
    if (action !== 'open-vnc') return { status: 'accepted', action, response: { RequestId: response.RequestId } };
    const raw = response.InstanceVncUrl?.trim();
    if (!raw) throw new BadGatewayException('腾讯云 VNC 响应缺少访问地址。');
    let decoded: string, url: URL;
    try { decoded = raw.includes('%') ? decodeURIComponent(raw) : raw; url = new URL(decoded); }
    catch { throw new BadGatewayException('腾讯云 VNC 地址响应格式不完整。'); }
    if (url.protocol !== 'wss:' || !/(^|\.)qcloud\.com$/i.test(url.hostname) || url.username || url.password)
      throw new BadGatewayException('腾讯云 VNC 地址响应不受支持。');
    return { status: 'accepted', action, vncUrl: raw,
      webTerminalUrl: `https://img.qcloud.com/qcloud/app/active_vnc/index.html?InstanceVncUrl=${encodeURIComponent(decoded)}` };
  }

  async runSingleInstanceAction(
    rangeInstanceId: string,
    action: 'reboot' | 'open-vnc' | 'pack-image',
    payload: Record<string, string>,
    currentUser?: AuthenticatedUser,
  ) {
    const instance = await this.adminRepository.getRangeInstanceById(rangeInstanceId);

    if (!instance) {
      throw new NotFoundException('Single instance not found');
    }

    if (instance.instanceMode !== 'single') {
      throw new NotFoundException('Single instance not found');
    }

    const hostKey =
      instance.singleInstanceConfig?.hostKey ??
      Object.keys(instance.resourceSummary?.hostIds ?? {})[0];

    if (!hostKey) {
      throw new NotFoundException('Range instance host node not found');
    }

    if(instance.status !== 'running') throw new ConflictException('Single instance action requires running status');
    const config=instance.singleInstanceConfig;
    if (instance.cloudProvider === 'tencent_cloud' && (!config?.cloudAccountContextId || !config.cloudAccountUid || !config.regionId))
      throw new ConflictException('腾讯云节点操作需要已冻结并核验的原云账号。');
    const account=config?.cloudAccountContextId?await this.systemConfigService.getAccountContextById(config.cloudAccountContextId):await this.systemConfigService.getAccountContext();
    if((config?.cloudAccountUid && config.cloudAccountUid!==account.accountUid)||(config?.regionId && config.regionId!==account.defaultRegion)) throw new ConflictException('Instance cloud context does not match its launch identity');
    return this.run(rangeInstanceId, hostKey, action, payload, currentUser, account);
  }

  private resolveHostInstanceId(instance: RangeInstanceRecord, nodeId: string) {
    const hostIds = instance.resourceSummary?.hostIds;
    const hostInstanceId = hostIds?.[nodeId];

    if (!hostInstanceId) {
      throw new NotFoundException('Range instance host node not found');
    }

    return hostInstanceId;
  }

  private resolveHostTopologyNode(instance: RangeInstanceRecord, nodeId: string) {
    const graph =
      (instance.draftTopologyGraph as Record<string, unknown> | null) ??
      (instance.runtimeTopologyGraph as Record<string, unknown> | null) ??
      null;

    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];

    for (const node of nodes) {
      if (!node || typeof node !== 'object') {
        continue;
      }

      if ((node as { id?: unknown }).id === nodeId) {
        return node as Record<string, unknown>;
      }
    }

    return null;
  }

  private async buildAliyunVncConsoleUrl(
    instance: RangeInstanceRecord,
    nodeId: string,
    hostInstanceId: string,
    rawVncUrl: string,
  ) {
    const encodedVncUrl = normalizeAliyunVncUrl(rawVncUrl);
    const isWindows = await this.resolveInstanceWindowsFlag(instance, nodeId);

    return `${ALICLOUD_VNC_CONSOLE_URL}?vncUrl=${encodedVncUrl}&instanceId=${encodeURIComponent(hostInstanceId)}&isWindows=${isWindows ? 'true' : 'false'}`;
  }

  private async resolveInstanceWindowsFlag(instance: RangeInstanceRecord, nodeId: string) {
    const nodes = Array.isArray(instance.runtimeTopologyGraph?.nodes) ? instance.runtimeTopologyGraph.nodes : [];
    const runtimeNode = nodes.find(node => node && typeof node === 'object' && (node as { id?: string }).id === nodeId) as Record<string, unknown> | undefined;
    const platformImageAssetId = instance.singleInstanceConfig?.platformImageAssetId
      ?? (typeof runtimeNode?.platformImageAssetId === 'string' ? runtimeNode.platformImageAssetId : undefined);

    if (platformImageAssetId) {
      const asset = await this.adminRepository.getPlatformImageAssetById(platformImageAssetId);
      const snapshot = asset?.sourceSnapshotId
        ? await this.adminRepository.getImageSnapshotById(asset.sourceSnapshotId)
        : null;
      const snapshotOsHint = `${snapshot?.osType ?? ''} ${snapshot?.platform ?? ''}`.trim();

      if (snapshotOsHint) {
        return isWindowsOsHint(snapshotOsHint);
      }
    }

    const username = instance.runtimeCredentials?.[nodeId]?.username?.trim();

    if (username) {
      return isWindowsUsername(username);
    }

    return isWindowsHost(this.resolveHostTopologyNode(instance, nodeId));
  }

  private async performAliyunRpcRequest<ResponsePayload>(input: {
    accessKeyId: string;
    accessKeySecret: string;
    regionId: string;
    action: string;
    parameters?: Record<string, string>;
  }): Promise<ResponsePayload> {
    return imageRpc<ResponsePayload>({ accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret, regionId: input.regionId }, input.action, input.parameters);
  }


}

function isNodeActionName(value: string): value is NodeActionName {
  return value === 'start' || value === 'stop' || value === 'reboot' || value === 'open-vnc' || value === 'pack-image';
}

function buildAliyunWebTerminalUrl(input: {
  regionId: string;
  instanceId: string;
  vncUrl: string;
  isWindows: boolean;
}) {
  const searchParams = new URLSearchParams({
    vncUrl: input.vncUrl,
    instanceId: input.instanceId,
    regionId: input.regionId,
    isWindows: input.isWindows ? 'true' : 'false',
  });

  return `https://g.alicdn.com/aliyun/ecs-console-vnc2/0.0.8/index.html?${searchParams.toString()}`;
}

function readHostName(hostNode: Record<string, unknown> | null, fallback: string) {
  if (typeof hostNode?.hostName === 'string' && hostNode.hostName.trim()) {
    return hostNode.hostName.trim();
  }

  if (typeof hostNode?.label === 'string' && hostNode.label.trim()) {
    return hostNode.label.trim();
  }

  return fallback;
}

function isWindowsHost(hostNode: Record<string, unknown> | null) {
  const imageName = String(
    hostNode?.imageName ?? hostNode?.imageId ?? hostNode?.image ?? '',
  ).toLowerCase();

  return imageName.includes('windows');
}

function normalizeAliyunVncUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  const decoded = trimmed.includes('%') ? safeDecodeURIComponent(trimmed) : trimmed;
  return encodeURIComponent(decoded);
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isWindowsOsHint(value: string) {
  return value.trim().toLowerCase().includes('windows');
}

function isWindowsUsername(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === 'administrator' || normalized.endsWith('\\administrator');
}
