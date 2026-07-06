import { randomUUID } from 'node:crypto';

import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository, RangeInstanceRecord } from './admin.repository';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { SystemConfigService } from './system-config.service';

const ALICLOUD_ECS_API_VERSION = '2014-05-26';
const ALICLOUD_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_SIGNATURE_VERSION = '1.0';

type NodeActionName = 'stop' | 'reboot' | 'open-vnc' | 'pack-image';

@Injectable()
export class RangeInstanceNodeActionsService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async run(rangeInstanceId: string, nodeId: string, action: string, payload: Record<string, string>) {
    const instance = await this.adminRepository.getRangeInstanceById(rangeInstanceId);

    if (!instance) {
      throw new NotFoundException('Range instance not found');
    }

    if (!isNodeActionName(action)) {
      throw new NotFoundException('Unsupported node action');
    }

    const hostInstanceId = this.resolveHostInstanceId(instance, nodeId);
    const accountContext = await this.systemConfigService.getAccountContext();

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

      return { status: 'accepted', action, vncUrl: response.VncUrl ?? null };
    }

    const displayName = payload.displayName?.trim() || `${nodeId}-snapshot`;
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
    });

    return {
      status: 'accepted',
      action,
      imageId,
      platformImageAsset,
    };
  }

  private resolveHostInstanceId(instance: RangeInstanceRecord, nodeId: string) {
    const hostIds = instance.resourceSummary?.hostIds;
    const hostInstanceId = hostIds?.[nodeId];

    if (!hostInstanceId) {
      throw new NotFoundException('Range instance host node not found');
    }

    return hostInstanceId;
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
      throw new Error(`Aliyun ${input.action} request failed with status ${response.status}`);
    }

    return (await response.json()) as ResponsePayload;
  }
}

function isNodeActionName(value: string): value is NodeActionName {
  return value === 'stop' || value === 'reboot' || value === 'open-vnc' || value === 'pack-image';
}
