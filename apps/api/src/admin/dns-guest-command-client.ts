import { imageRpc, cloudItems, cloudTags } from './aliyun-image-rpc';
import { assertTencentOwnedInstance, describeTencentInstances } from './tencent-cloud-resources';
import { requestTencentCloud } from './tencent-cloud-client';
import type { RangeInstanceRecord } from './admin.repository';
import type { SystemCloudAccountContext } from './system-config.service';

const receipt = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)) throw new Error('DNS_CLOUD_RECEIPT_INVALID');
  return value;
};
export type GuestCommandResult = { status: 'pending' | 'success' | 'failed'; output?: string; exitCode?: number; requestId: string };

// Only the platform's fixed DNS reader is submitted; no caller-supplied command or cloud ID is accepted.
export class DnsGuestCommandClient {
  async assertOwned(instance: RangeInstanceRecord, nodeId: string, id: string, account: SystemCloudAccountContext) {
    const source = instance.resourceSummary?.executionContext;
    if (!source || source.provider !== account.provider || source.cloudAccountContextId !== account.cloudAccountContextId
      || source.cloudAccountUid !== account.accountUid || source.regionId !== account.defaultRegion || !account.accountUidResolved)
      throw new Error('DNS_FROZEN_ACCOUNT_MISMATCH');
    if (account.provider === 'tencent_cloud') {
      if (!/^ins-[a-z0-9]+$/.test(id)) throw new Error('DNS_INSTANCE_ID_INVALID');
      const rows = await describeTencentInstances(account, { instanceIds: [id] });
      if (rows.length !== 1 || rows[0].instanceId !== id || rows[0].status !== 'Running') throw new Error('DNS_INSTANCE_NOT_RUNNING');
      assertTencentOwnedInstance(instance, account, rows[0], nodeId);
      return;
    }
    if (account.provider !== 'alibaba_cloud' || !/^i-[a-z0-9]+$/.test(id)) throw new Error('DNS_INSTANCE_ID_INVALID');
    const response = await this.ali(account, 'DescribeInstances', { InstanceIds: JSON.stringify([id]), PageSize: '100', PageNumber: '1' });
    receipt(response.RequestId);
    const rows = cloudItems<Record<string, any>>(response, 'Instances', 'Instance');
    if (Number(response.TotalCount) !== 1 || rows.length !== 1 || rows[0].InstanceId !== id
      || rows[0].RegionId !== account.defaultRegion || rows[0].Status !== 'Running') throw new Error('DNS_INSTANCE_NOT_RUNNING');
    const tags = cloudTags(rows[0].Tags);
    if (tags.CreatedBy !== 'cyber-range-platform' || tags.CloudAccountUid !== account.accountUid
      || tags.CloudAccountContextId !== account.cloudAccountContextId || tags.PlatformHostKey !== nodeId
      || ![tags.RangeInstanceId, tags.PlatformRangeInstanceId, tags.range_instance_id].includes(instance.id)
      || instance.ownerUserId && tags.PlatformUserId !== instance.ownerUserId) throw new Error('DNS_INSTANCE_OWNERSHIP_UNPROVEN');
  }

  async submit(account: SystemCloudAccountContext, id: string, script: string, nonce: string) {
    const encoded = Buffer.from(script, 'utf8').toString('base64');
    if (encoded.length > 64 * 1024) throw new Error('DNS_COMMAND_TOO_LARGE');
    if (account.provider === 'tencent_cloud') {
      const result = await this.tencent(account, 'RunCommand', { InstanceIds: [id], Content: encoded,
        CommandType: 'POWERSHELL', CommandName: `dns-check-${nonce.slice(0, 24)}`, Timeout: 60,
        SaveCommand: false, EnableParameter: false });
      const invocationId = receipt(result.InvocationId);
      if (!/^inv-[a-z0-9]+$/.test(invocationId)) throw new Error('DNS_CLOUD_RECEIPT_INVALID');
      return { invocationId, requestId: receipt(result.RequestId) };
    }
    const result = await this.ali(account, 'RunCommand', { 'InstanceId.1': id, CommandContent: encoded,
      Type: 'RunPowerShellScript', Name: `dns-check-${nonce.slice(0, 24)}`, Timeout: '60', KeepCommand: 'false',
      ContentEncoding: 'Base64', RepeatMode: 'Once', EnableParameter: 'false' });
    return { invocationId: receipt(result.InvokeId), requestId: receipt(result.RequestId) };
  }

  async read(account: SystemCloudAccountContext, invocationId: string, id: string): Promise<GuestCommandResult> {
    receipt(invocationId);
    if (account.provider === 'tencent_cloud') {
      const result = await this.tencent(account, 'DescribeInvocationTasks', { Filters: [{ Name: 'invocation-id', Values: [invocationId] }],
        Offset: 0, Limit: 100, HideOutput: false });
      const requestId = receipt(result.RequestId);
      const rows = result.InvocationTaskSet;
      if (!Array.isArray(rows) || result.TotalCount !== rows.length || rows.length > 1 || result.NextToken)
        throw new Error('DNS_COMMAND_RESULT_INCOMPLETE');
      if (!rows.length && result.TotalCount === 0) return { status: 'pending', requestId };
      const row = rows[0];
      if (row.InstanceId !== id || row.InvocationId !== invocationId) throw new Error('DNS_COMMAND_RESULT_MISMATCH');
      if (['PENDING', 'DELIVERING', 'DELIVER_DELAYED', 'RUNNING'].includes(row.TaskStatus)) return { status: 'pending', requestId };
      const output = row.TaskResult;
      if (!output || typeof output !== 'object' || output.Dropped !== 0 || output.OutputUrl) throw new Error('DNS_COMMAND_RESULT_INCOMPLETE');
      return { status: row.TaskStatus === 'SUCCESS' ? 'success' : 'failed', requestId, output: this.decode(output.Output), exitCode: output.ExitCode };
    }
    const result = await this.ali(account, 'DescribeInvocationResults', { InvokeId: invocationId, 'InstanceId.1': id,
      ContentEncoding: 'Base64', PageSize: '1', PageNumber: '1' });
    const requestId = receipt(result.RequestId), page = result.Invocation;
    if (!page || page.NextToken || result.NextToken) throw new Error('DNS_COMMAND_RESULT_INCOMPLETE');
    const rows = cloudItems<Record<string, any>>(page, 'InvocationResults', 'InvocationResult');
    if (Number(page.TotalCount) !== rows.length || rows.length > 1) throw new Error('DNS_COMMAND_RESULT_INCOMPLETE');
    if (!rows.length) return { status: 'pending', requestId };
    const row = rows[0];
    if (row.InstanceId !== id || row.InvokeId !== invocationId) throw new Error('DNS_COMMAND_RESULT_MISMATCH');
    if (['Pending', 'Running', 'Scheduled'].includes(row.InvocationStatus)) return { status: 'pending', requestId };
    if (row.Dropped !== 0) throw new Error('DNS_COMMAND_RESULT_INCOMPLETE');
    return { status: row.InvocationStatus === 'Success' ? 'success' : 'failed', requestId, output: this.decode(row.Output), exitCode: row.ExitCode };
  }

  private decode(value: unknown) {
    if (typeof value !== 'string' || value.length > 32 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      throw new Error('DNS_COMMAND_OUTPUT_INVALID');
    const data = Buffer.from(value, 'base64');
    if (data.length > 24 * 1024 || data.toString('base64') !== value) throw new Error('DNS_COMMAND_OUTPUT_INVALID');
    return data.toString('utf8');
  }
  private ali(account: SystemCloudAccountContext, action: string, parameters: Record<string, string>) {
    return imageRpc<Record<string, any>>({ provider: account.provider, accessKeyId: account.accessKeyId,
      accessKeySecret: account.accessKeySecret, regionId: account.defaultRegion }, action, parameters);
  }
  private tencent(account: SystemCloudAccountContext, action: string, parameters: Record<string, unknown>) {
    return requestTencentCloud<Record<string, any>>({ service: 'tat', action, version: '2020-10-28', regionId: account.defaultRegion,
      accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret, parameters });
  }
}
