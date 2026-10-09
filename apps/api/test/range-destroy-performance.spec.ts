import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

function worker() {
  return new ProvisioningWorkerService(createMemoryAdminRepository(), {} as any, {} as any, {} as any, {} as any, {} as any) as any;
}
const account = { accessKeyId: 'fixture', accessKeySecret: 'fixture', defaultRegion: 'cn-hangzhou' };

describe('range destroy verification performance and completeness', () => {
  it('checks independent resources concurrently within a four-request budget and deduplicates EIPs', async () => {
    const service = worker(); let active = 0, peak = 0;
    const check = jest.fn(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return false; });
    service.checkVpcExists = jest.fn().mockResolvedValue(true);
    service.checkVSwitchExists = check; service.checkNetworkInterfaceExists = check; service.checkNatGatewayExists = check; service.checkEipExists = check;
    service.findExistingInstanceIds = jest.fn(async () => { await check(); return []; });
    const residual = await service.findResidualCloudResources({ mode: 'opentofu', vpcId: 'vpc-owned', subnetIds: { a: 's-a', b: 's-b' }, hostIds: { a: 'i-a' },
      secondaryNetworkInterfaceIds: { a: 'eni-a', b: 'eni-b' }, natGatewayIds: { a: 'nat-a' }, eipAllocationId: 'eip-a', eipAllocationIds: { a: 'eip-a', b: 'eip-b' } }, account);
    expect(residual).toEqual(['vpc:vpc-owned']);
    expect(peak).toBe(4);
    expect(check).toHaveBeenCalledTimes(8);
  });

  it('propagates a verification failure and waits for other in-flight checks to settle', async () => {
    const service = worker(); let active = 0;
    service.checkVpcExists = jest.fn().mockResolvedValue(false);
    service.findExistingInstanceIds = jest.fn().mockResolvedValue([]);
    service.checkNetworkInterfaceExists = jest.fn(async () => { active++; await new Promise(resolve => setTimeout(resolve, 10)); active--; return false; });
    service.checkEipExists = jest.fn().mockRejectedValue(new Error('Synthetic verification failure'));
    await expect(service.findResidualCloudResources({ mode: 'opentofu', secondaryNetworkInterfaceIds: { a: 'eni-a' }, eipAllocationId: 'eip-a' }, account)).rejects.toThrow('verification failure');
    expect(active).toBe(0);
  });

  it('chunks ECS IDs into complete pages of 100 and preserves exact requested identities', async () => {
    const service = worker();
    service.performAliyunRpcRequest = jest.fn(async input => {
      expect(input.parameters.PageSize).toBe('100');
      const ids = JSON.parse(input.parameters.InstanceIds);
      return { TotalCount: ids.length, Instances: { Instance: ids.map(InstanceId => ({ InstanceId })) } };
    });
    const ids = Array.from({ length: 205 }, (_, index) => `i-${index}`);
    expect(await service.findExistingInstanceIds([...ids, ids[0]], account, account.defaultRegion)).toEqual(ids);
    expect(service.performAliyunRpcRequest.mock.calls.map(([input]) => JSON.parse(input.parameters.InstanceIds).length)).toEqual([100, 100, 5]);
  });

  it.each([
    {}, { Instances: { Instance: [{}] } },
    { Instances: { Instance: [{ InstanceId: 'i-other' }] } },
    { Instances: { Instance: [{ InstanceId: 'i-owned' }, { InstanceId: 'i-owned' }] } },
    { TotalCount: 2, Instances: { Instance: [{ InstanceId: 'i-owned' }] } },
  ])('rejects malformed or partial ECS absence evidence %#', async payload => {
    const service = worker(); service.performAliyunRpcRequest = jest.fn().mockResolvedValue(payload);
    await expect(service.findExistingInstanceIds(['i-owned'], account, account.defaultRegion)).rejects.toThrow('destroy verification response');
  });

  it('does not query the cloud for synthetic dry-run resource summaries', async () => {
    const service = worker(); service.performAliyunRpcRequest = jest.fn();
    expect(await service.findResidualCloudResources({ mode: 'dry-run', vpcId: 'synthetic' }, account)).toEqual([]);
    expect(service.performAliyunRpcRequest).not.toHaveBeenCalled();
  });
});
