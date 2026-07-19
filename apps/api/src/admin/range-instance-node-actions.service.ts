import { randomUUID } from 'node:crypto';

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
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { SystemConfigService } from './system-config.service';

const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';
const ALICLOUD_VNC_CONSOLE_URL = 'https://g.alicdn.com/aliyun/ecs-console-vnc2/0.0.8/index.html';

type NodeActionName = 'start' | 'stop' | 'reboot' | 'open-vnc' | 'pack-image';
type AuthenticatedUser = Pick<SessionUserProfile, 'id' | 'role'>;

@Injectable()
export class RangeInstanceNodeActionsService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async run(
    rangeInstanceId: string,
    nodeId: string,
    action: string,
    payload: Record<string, string>,
    currentUser?: AuthenticatedUser,
  ) {
    const instance = await this.adminRepository.getRangeInstanceById(rangeInstanceId);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (currentUser && currentUser.role !== 'admin' && instance.ownerUserId !== currentUser.id) {
      throw new ForbiddenException('Range instance access denied');
    }

    if (!isNodeActionName(action)) {
      throw new NotFoundException('Unsupported node action');
    }

    if (instance.resourceSummary?.mode === 'dry-run') {
      throw new ConflictException(
        '此实例以 dry-run 模式创建，未下发阿里云 ECS 或网络资源；请切换到 opentofu 后重新创建实例再执行节点操作。',
      );
    }

    const hostInstanceId = this.resolveHostInstanceId(instance, nodeId);
    const hostNode = this.resolveHostTopologyNode(instance, nodeId);
    const accountContext = await this.systemConfigService.getAccountContext();

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
    const ownerUserId = payload.ownerUserId?.trim() || instance.ownerUserId || null;
    const createImageResponse = await this.performAliyunRpcRequest<{
      ImageId?: string;
    }>({
      accessKeyId: accountContext.accessKeyId,
      accessKeySecret: accountContext.accessKeySecret,
      regionId: accountContext.defaultRegion,
        action: 'CreateImage',
        parameters: {
          InstanceId: hostInstanceId,
          ImageName: displayName,
          ...(description ? { Description: description } : {}),
          ...buildAliyunTagParameters(
            buildBillingTags({
              billingScope: ownerUserId ? 'user' : 'platform',
              ownerUserId,
              rangeInstanceId,
              billingStartAt: new Date(),
            }),
          ),
        },
      });

    const imageId = createImageResponse.ImageId?.trim();

    if (!imageId) {
      throw new Error('Aliyun CreateImage response is missing ImageId');
    }

    const syncedAt = new Date();
    await this.adminRepository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
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

    const snapshot = (await this.adminRepository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: accountContext.accountUid,
      regionId: accountContext.defaultRegion,
      scope: 'custom',
      imageId,
    }))[0];

    if (!snapshot) {
      throw new Error('Image snapshot was not persisted after CreateImage');
    }

    const platformImageAsset = await this.adminRepository.collectPlatformImageAsset({
      snapshotId: snapshot.id,
      displayName,
      defaultHostName,
      defaultPassword,
      description,
      ownerUserId,
      visibility: 'private',
    });
    await this.syncPackedImageBillingLedger({
      imageId,
      ownerUserId,
      rangeInstanceId,
      platformImageAssetId: platformImageAsset.id,
      regionId: accountContext.defaultRegion,
      accountUid: accountContext.accountUid,
      billingStartAt: syncedAt,
    });

    return {
      status: 'accepted',
      action,
      imageId,
      defaultHostName,
      defaultPassword,
      description,
      imageReady: snapshot.isAvailable,
      platformImageAsset,
    };
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

    return this.run(rangeInstanceId, hostKey, action, payload, currentUser);
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
    const platformImageAssetId = instance.singleInstanceConfig?.platformImageAssetId;

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
    const endpoint = `https://ecs.${input.regionId}.aliyuncs.com/`;
    const query = signAliyunRpcQuery(
      {
        Action: input.action,
        AccessKeyId: input.accessKeyId,
        Format: 'JSON',
        RegionId: input.regionId,
        SignatureMethod: ALICLOUD_SIGNATURE_METHOD,
        SignatureNonce: randomUUID(),
        SignatureVersion: ALICLOUD_SIGNATURE_VERSION,
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        Version: ALICLOUD_ECS_API_VERSION,
        ...(input.parameters ?? {}),
      },
      input.accessKeySecret,
    );
    const response = await fetch(`${endpoint}?${query}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const bodyText = await response.text();
      let details: Record<string, unknown> | null = null;

      try {
        details = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        details = null;
      }

      const detailMessage =
        typeof details?.Message === 'string'
          ? details.Message
          : typeof details?.message === 'string'
            ? details.message
            : bodyText.trim();
      const code =
        typeof details?.Code === 'string'
          ? details.Code
          : typeof details?.code === 'string'
            ? details.code
            : null;
      const message = code
        ? `Aliyun ${input.action} request failed: ${code}${detailMessage ? ` - ${detailMessage}` : ''}`
        : `Aliyun ${input.action} request failed with status ${response.status}${detailMessage ? ` - ${detailMessage}` : ''}`;

      throw new BadGatewayException(message);
    }

    return (await response.json()) as ResponsePayload;
  }

  private async syncPackedImageBillingLedger(input: {
    imageId: string;
    ownerUserId: string | null;
    rangeInstanceId: string;
    platformImageAssetId: string;
    regionId: string;
    accountUid: string | null;
    billingStartAt: Date;
  }) {
    const billingScope = input.ownerUserId ? 'user' : 'platform';

    for (const cloudResourceType of ['image', 'snapshot'] as const) {
      const existing = await this.adminRepository.findBillingLedgerResource({
        cloudProvider: 'alibaba_cloud',
        regionId: input.regionId,
        cloudResourceId: input.imageId,
        cloudResourceType,
      });

      if (existing) {
        await this.adminRepository.updateBillingLedgerResource(existing.id, {
          billingScope,
          ownerUserId: input.ownerUserId,
          rangeInstanceId: input.rangeInstanceId,
          platformImageAssetId: input.platformImageAssetId,
          releasedAt: null,
        });
        continue;
      }

      await this.adminRepository.createBillingLedgerResource({
        cloudProvider: 'alibaba_cloud',
        cloudAccountUid: input.accountUid,
        regionId: input.regionId,
        cloudResourceId: input.imageId,
        cloudResourceType,
        billingScope,
        ownerUserId: input.ownerUserId,
        rangeInstanceId: input.rangeInstanceId,
        platformImageAssetId: input.platformImageAssetId,
        billingStartAt: input.billingStartAt,
        tagsSnapshot: {},
      });
    }
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
