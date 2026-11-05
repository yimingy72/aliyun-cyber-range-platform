import { Injectable } from '@nestjs/common';
import { isIPv4 } from 'node:net';
import { imageRpc } from './aliyun-image-rpc';
import { RangeNodeResetCloudClient, type ResetCloudRow } from './range-node-reset-cloud.client';
import type { SystemCloudAccountContext } from './system-config.service';
import { powerHash, type PowerHostFact } from './instance-power-types';

@Injectable()
export class InstancePowerCloudClient extends RangeNodeResetCloudClient {
  async modifyReleaseTime(account: SystemCloudAccountContext, instanceId: string, at: string) {
    if (!/^i-[A-Za-z0-9-]+$/.test(instanceId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(at)
      || Date.parse(at) < Date.now() + 30 * 60_000) throw new Error('EXPIRY_INVALID_NATIVE_PARAMETERS');
    const body = await imageRpc<{ RequestId?: string }>(this.credentials(account), 'ModifyInstanceAutoReleaseTime', {
      InstanceId: instanceId, AutoReleaseTime: at,
    });
    if (!body.RequestId || !/^[A-Za-z0-9-]{1,128}$/.test(body.RequestId)
      || [account.accessKeyId, account.accessKeySecret].filter(Boolean).some(secret => body.RequestId!.includes(secret))) throw new Error('EXPIRY_RECEIPT_UNVERIFIED');
    return { requestId: body.RequestId };
  }

  async stopEconomical(account: SystemCloudAccountContext, instanceId: string) {
    const body = await imageRpc<{ RequestId?: string }>(this.credentials(account), 'StopInstance', {
      InstanceId: instanceId, ForceStop: 'false', StoppedMode: 'StopCharging',
    });
    if (!body.RequestId || !/^[A-Za-z0-9-]{1,128}$/.test(body.RequestId)
      || [account.accessKeyId, account.accessKeySecret].filter(Boolean).some(secret => body.RequestId!.includes(secret))) throw new Error('POWER_RECEIPT_UNVERIFIED');
    return { requestId: body.RequestId };
  }

  async assertEconomicalSupported(account: SystemCloudAccountContext, host: ResetCloudRow) {
    if (host.InstanceChargeType !== 'PostPaid' || host.InstanceNetworkType !== 'vpc') throw new Error('POWER_REQUIRES_POSTPAID_VPC');
    const type = host.InstanceType;
    if (typeof type !== 'string' || !/^ecs\.[A-Za-z0-9.-]+$/.test(type)) throw new Error('POWER_INSTANCE_TYPE_UNVERIFIED');
    const rows: ResetCloudRow[] = [], seen = new Set<string>();
    let next: string | undefined;
    do {
      const body = await imageRpc<{ InstanceTypes?: { InstanceType?: ResetCloudRow[] }; NextToken?: string }>(this.credentials(account), 'DescribeInstanceTypes', {
        'InstanceTypes.1': type, MaxResults: '100', ...(next ? { NextToken: next } : {}),
      });
      if (!Array.isArray(body.InstanceTypes?.InstanceType) || body.NextToken !== undefined && typeof body.NextToken !== 'string') throw new Error('POWER_INSTANCE_TYPE_UNVERIFIED');
      rows.push(...body.InstanceTypes.InstanceType);
      next = body.NextToken || undefined;
      if (next && (seen.has(next) || seen.size >= 10)) throw new Error('POWER_INSTANCE_TYPE_UNVERIFIED');
      if (next) seen.add(next);
    } while (next);
    if (rows.length !== 1 || rows[0].InstanceTypeId !== type || typeof rows[0].InstanceTypeFamily !== 'string') throw new Error('POWER_INSTANCE_TYPE_UNVERIFIED');
    const details = rows[0];
    // ECS omits non-applicable local-storage fields for cloud-disk-only types.
    // Do not mistake omission for malformed metadata, nor accept malformed/positive values.
    for (const key of ['LocalStorageAmount', 'LocalStorageCapacity', 'PersistentMemorySize']) {
      if (details[key] !== undefined && (typeof details[key] !== 'number' || !Number.isFinite(details[key]) || details[key] < 0)) throw new Error('POWER_INSTANCE_TYPE_UNVERIFIED');
    }
    if ((details.LocalStorageAmount ?? 0) !== 0 || (details.LocalStorageCapacity ?? 0) > 0
      || details.LocalStorageCategory
      || ['ecs.re6p', 'ecs.re6p-redis'].includes(details.InstanceTypeFamily) || Number(details.PersistentMemorySize ?? 0) > 0)
      throw new Error('POWER_LOCAL_OR_PERSISTENT_MEMORY_UNSUPPORTED');
  }

  networkDigest(host: ResetCloudRow) {
    const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value].sort() : [];
    const privateIps = strings(host.VpcAttributes?.PrivateIpAddress?.IpAddress);
    const groups = strings(host.SecurityGroupIds?.SecurityGroupId);
    const interfaces = host.NetworkInterfaces?.NetworkInterface;
    if (!host.VpcAttributes?.VpcId || !host.VpcAttributes?.VSwitchId || !privateIps.length || !privateIps.every(isIPv4)
      || !groups.length || !Array.isArray(interfaces) || !interfaces.length
      || interfaces.some(nic => typeof nic.NetworkInterfaceId !== 'string')) throw new Error('POWER_NETWORK_UNVERIFIED');
    return powerHash({ vpc: host.VpcAttributes.VpcId, subnet: host.VpcAttributes.VSwitchId, privateIps, groups,
      interfaces: interfaces.map(nic => ({ id: nic.NetworkInterfaceId, mac: nic.MacAddress ?? null, privateIp: nic.PrimaryIpAddress ?? null }))
        .sort((a, b) => a.id.localeCompare(b.id)), eipId: host.EipAddress?.AllocationId ?? null, autoReleaseTime: host.AutoReleaseTime ?? null });
  }

  tags(host: ResetCloudRow): Record<string, string> {
    const rows = host.Tags?.Tag;
    if (!Array.isArray(rows)) throw new Error('POWER_TAGS_UNVERIFIED');
    const result: Record<string, string> = Object.create(null);
    for (const row of rows) {
      const key = row?.TagKey ?? row?.Key, value = row?.TagValue ?? row?.Value;
      if (typeof key !== 'string' || typeof value !== 'string' || Object.hasOwn(result, key)) throw new Error('POWER_TAGS_UNVERIFIED');
      result[key] = value;
    }
    return result;
  }

  fact(host: ResetCloudRow): PowerHostFact {
    const ips = host.PublicIpAddress?.IpAddress;
    if (ips !== undefined && (!Array.isArray(ips) || ips.some(ip => typeof ip !== 'string' || !isIPv4(ip)))) throw new Error('POWER_PUBLIC_IP_UNVERIFIED');
    const eip = host.EipAddress?.IpAddress;
    if (eip && (typeof eip !== 'string' || !isIPv4(eip))) throw new Error('POWER_PUBLIC_IP_UNVERIFIED');
    const reclaimed = host.Status === 'Stopped' && host.StoppedMode === 'StopCharging' && !eip;
    return { instanceId: host.InstanceId, status: host.Status, stoppedMode: host.StoppedMode ?? null, publicIp: reclaimed ? null : eip || ips?.[0] || null, checkedAt: new Date().toISOString() };
  }

  runningReady(host: ResetCloudRow) {
    return host.Status === 'Running' && (!(Number(host.InternetMaxBandwidthOut) > 0) || Boolean(this.fact(host).publicIp));
  }

  private credentials(account: SystemCloudAccountContext) {
    if (account.provider !== 'alibaba_cloud' || !account.accountUidResolved) throw new Error('POWER_ACCOUNT_UNVERIFIED');
    return { provider: account.provider, regionId: account.defaultRegion, accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret };
  }
}
