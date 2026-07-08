import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('createMemoryAdminRepository single-instance extensions', () => {
  it('stores instanceMode, singleInstanceConfig, and default network profile fields', async () => {
    const repository = createMemoryAdminRepository();
    const singleInstanceConfig = {
      baseName: 'web-lab',
      quantityIndex: 1,
      hostKey: 'single-ecs-1',
      hostName: 'web-lab-host',
      platformImageAssetId: 'platform-image-1',
      imageId: 'm-123',
      imageDisplayName: 'Ubuntu 24.04 LTS',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      remark: 'single instance',
      assignedVswitchId: 'vsw-1',
    };
    const runtimeTopologyGraph = {
      nodes: [{ id: 'host-1', kind: 'host' }],
    };
    const vswitchIds = ['vsw-a', 'vsw-b', 'vsw-c'];
    const vswitchCidrs = ['10.200.1.0/24', '10.200.2.0/24', '10.200.3.0/24'];

    const single = await repository.createRangeInstance({
      name: 'web-lab-01',
      createdBy: 'admin',
      status: 'pending_create',
      instanceMode: 'single',
      expiresAt: '2026-07-10T12:00:00.000Z',
      singleInstanceConfig,
      runtimeTopologyGraph,
    });

    await repository.upsertSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      vpcId: 'vpc-1',
      vpcCidr: '10.200.0.0/16',
      vswitchIds,
      vswitchCidrs,
      securityGroupId: 'sg-1',
      securityGroupName: 'default-open-all',
    });

    const reloaded = await repository.getRangeInstanceById(single.id);
    const network = await repository.getSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
    });

    expect(reloaded?.instanceMode).toBe('single');
    expect(reloaded?.singleInstanceConfig).toMatchObject({
      hostKey: 'single-ecs-1',
      platformImageAssetId: 'platform-image-1',
      cpu: 2,
      memory: 2,
    });
    expect(network).toMatchObject({
      vpcId: 'vpc-1',
      vswitchIds: ['vsw-a', 'vsw-b', 'vsw-c'],
      securityGroupId: 'sg-1',
    });

    singleInstanceConfig.hostKey = 'mutated-input-host';
    runtimeTopologyGraph.nodes[0].id = 'mutated-node';
    vswitchIds.push('vsw-input-mutated');
    vswitchCidrs.push('10.200.99.0/24');

    const reloadedFromOriginalInputMutation = await repository.getRangeInstanceById(single.id);
    const networkFromOriginalInputMutation = await repository.getSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
    });

    expect(reloadedFromOriginalInputMutation?.singleInstanceConfig).toMatchObject({
      hostKey: 'single-ecs-1',
    });
    expect(reloadedFromOriginalInputMutation?.runtimeTopologyGraph).toMatchObject({
      nodes: [{ id: 'host-1', kind: 'host' }],
    });
    expect(networkFromOriginalInputMutation?.vswitchIds).toEqual(['vsw-a', 'vsw-b', 'vsw-c']);
    expect(networkFromOriginalInputMutation?.vswitchCidrs).toEqual([
      '10.200.1.0/24',
      '10.200.2.0/24',
      '10.200.3.0/24',
    ]);

    reloaded?.singleInstanceConfig && (reloaded.singleInstanceConfig.hostKey = 'mutated-host');
    network?.vswitchIds.push('vsw-mutated');

    const reloadedAgain = await repository.getRangeInstanceById(single.id);
    const networkAgain = await repository.getSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
    });

    expect(reloadedAgain?.singleInstanceConfig).toMatchObject({
      hostKey: 'single-ecs-1',
    });
    expect(networkAgain?.vswitchIds).toEqual(['vsw-a', 'vsw-b', 'vsw-c']);
  });
});
