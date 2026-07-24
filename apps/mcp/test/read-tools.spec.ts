import { describe, expect, it, vi } from 'vitest';

import { PlatformApiError, type PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';
import type { ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime';

import { createToolRegistry } from '../src/server';

type ClientStub = PlatformApiClientLike & {
  getInstanceTypeAvailability: ReturnType<typeof vi.fn>;
};

const authoringGraph: ScenarioGraphDraft = {
  schemaVersion: '2.0.0',
  nodes: [
    {
      id: 'router-main', kind: 'router', label: '主 VPC', routeRole: 'vpc', egressType: 'none', bindEip: false,
    },
    {
      id: 'switch-dmz', kind: 'switch', label: 'DMZ 交换机', zoneKey: 'dmz', cidr: '10.0.0.0/24', purpose: 'dmz',
      nat: { snatEnabled: true, dnatMappings: [{ key: 'nginx-80', targetHostId: 'ecs-nginx', externalPort: 80, internalPort: 80, protocol: 'tcp' }] },
      aclRules: [],
    },
    {
      id: 'ecs-nginx', kind: 'ecs', label: 'Nginx', zoneKey: 'dmz', role: 'entry', privateIp: '10.0.0.10', exposePublic: true,
      image: 'img-nginx', imageId: 'img-nginx', platformImageAssetId: 'asset-nginx',
      dnatMappings: [], networkInterfaces: [], portGroups: [], initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'img-nginx' }, instanceTypeStrategy: { mode: 'auto' },
      nics: [{ id: 'nic-nginx', switchId: 'switch-dmz', privateIp: '10.0.0.10', secondaryIps: [], securityGroupRules: [{ key: 'http', direction: 'ingress', protocol: 'tcp', portRange: '80/80', sourceCidr: '0.0.0.0/0', policy: 'accept', priority: 1 }] }],
    },
  ],
  edges: [
    { id: 'router-to-switch-dmz', fromNodeId: 'router-main', toNodeId: 'switch-dmz', relationType: 'manual' as const },
    { id: 'switch-dmz-to-nginx', fromNodeId: 'switch-dmz', toNodeId: 'ecs-nginx', relationType: 'manual' as const },
  ],
};

const minimalAuthoringGraph = {
  schemaVersion: '2.0.0',
  nodes: [
    { id: 'router-main', kind: 'router', label: '主 VPC' },
    { id: 'switch-dmz', kind: 'switch', label: 'DMZ 交换机', zoneKey: 'dmz', cidr: '10.0.0.0/24', purpose: 'dmz' },
    {
      id: 'ecs-entry', kind: 'ecs', label: '入口主机', zoneKey: 'dmz', role: 'entry', privateIp: '10.0.0.10', exposePublic: true,
      image: 'm-entry-image', nics: [{ id: 'nic-entry', switchId: 'switch-dmz', privateIp: '10.0.0.10' }],
    },
  ],
  edges: [
    { id: 'router-to-switch-dmz', fromNodeId: 'router-main', toNodeId: 'switch-dmz', relationType: 'manual' },
    { id: 'switch-dmz-to-entry', fromNodeId: 'switch-dmz', toNodeId: 'ecs-entry', relationType: 'manual' },
  ],
} as unknown as ScenarioGraphDraft;

function createAuthoringTemplate(topologyGraph = authoringGraph, topologySpec?: Record<string, unknown>) {
  return {
    id: 'tpl-1',
    name: 'Web DMZ',
    slug: 'web-dmz',
    version: '1.0.0',
    cloudProvider: 'alibaba_cloud',
    iacType: 'opentofu',
    modulePathOrRef: 'modules/enterprise-range',
    revision: 7,
    topologyGraph,
    ...(topologySpec ? { topologySpec } : {}),
  };
}

function createClientStub(): ClientStub {
  return {
    listRangeTemplates: vi.fn().mockResolvedValue([{ id: 'tpl-1' }]),
    getRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    createRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-2' }),
    updateRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    cloneRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-2' }),
    saveRangeTemplateTopology: vi.fn().mockResolvedValue({ id: 'tpl-1', revision: 8 }),
    publishRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    unpublishRangeTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    removeRangeTemplate: vi.fn().mockResolvedValue(undefined),
    listPlatformImages: vi.fn().mockResolvedValue([{ id: 'img-1' }]),
    collectPlatformImage: vi.fn().mockResolvedValue({ id: 'img-2' }),
    renamePlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', displayName: 'renamed' }),
    publishPlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', visibility: 'platform' }),
    unpublishPlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', visibility: 'private' }),
    enablePlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', enabled: true }),
    disablePlatformImage: vi.fn().mockResolvedValue({ id: 'img-1', enabled: false }),
    removePlatformImage: vi.fn().mockResolvedValue(undefined),
    listImageCatalog: vi.fn().mockResolvedValue({ snapshots: [{ id: 'snapshot-1' }], catalogItems: [] }),
    syncImageCatalog: vi.fn().mockResolvedValue({ snapshots: [{ id: 'snapshot-1' }], catalogItems: [] }),
    removeCustomImageSnapshot: vi.fn().mockResolvedValue(undefined),
    listImageImportJobs: vi.fn().mockResolvedValue({ items: [{ id: 'import-1', status: 'failed' }] }),
    retryImageImport: vi.fn().mockResolvedValue({ id: 'import-1', status: 'importing' }),
    listRangeInstances: vi.fn().mockResolvedValue([{ id: 'range-1' }]),
    getRangeInstance: vi.fn().mockResolvedValue({ id: 'range-1' }),
    getRangeInstanceAccess: vi.fn().mockResolvedValue({ accessEntry: { publicIp: '1.1.1.1' } }),
    saveRangeInstanceDraft: vi.fn().mockResolvedValue({ id: 'range-1' }),
    applyRangeInstanceDraft: vi.fn().mockResolvedValue({ id: 'job-1' }),
    syncRangeInstanceTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    retryRangeInstance: vi.fn().mockResolvedValue({ id: 'job-1' }),
    removeFailedRangeInstance: vi.fn().mockResolvedValue(undefined),
    runRangeInstanceNodeAction: vi.fn().mockResolvedValue({ status: 'accepted' }),
    listSingleInstances: vi.fn().mockResolvedValue({ batches: [{ batch: { id: 'batch-1', name: 'batch-a' }, instances: [{ id: 'ins-1', name: 'ins-1', accessEntry: { publicIp: '1.1.1.1' }, runtimeCredentials: { 'single-ecs-1': { username: 'root', password: 'secret' } }, singleInstanceConfig: { hostKey: 'single-ecs-1', imageDisplayName: 'Ubuntu 24.04' } }] }], standaloneInstances: [{ id: 'ins-1' }] }),
    getSingleInstance: vi.fn().mockResolvedValue({ id: 'ins-1' }),
    getSingleInstanceAccess: vi.fn().mockResolvedValue({ runtimeCredentials: {} }),
    listProvisionJobs: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
    getProvisionJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
    fetchCloudConfig: vi.fn().mockResolvedValue({ provider: 'alibaba_cloud' }),
    saveCloudConfig: vi.fn().mockResolvedValue({ provider: 'alibaba_cloud', defaultRegion: 'cn-hangzhou' }),
    listAdminUsers: vi.fn().mockResolvedValue([{ id: 'user-1', username: 'alice' }]),
    createAdminUser: vi.fn().mockResolvedValue({ id: 'user-2', username: 'bob' }),
    updateAdminUserRole: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice', role: 'admin' }),
    updateAdminUserStatus: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice', status: 'disabled' }),
    resetAdminUserPassword: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice' }),
    getBillingSummary: vi.fn().mockResolvedValue({ totalPretaxAmount: 12.5 }),
    listBillingUsers: vi.fn().mockResolvedValue([{ userId: 'user-1', username: 'alice' }]),
    getBillingUserSummary: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'alice' }),
    listBillingUserGroups: vi.fn().mockResolvedValue([{ id: 'group-1' }]),
    listBillingPlatformGroups: vi.fn().mockResolvedValue([{ id: 'group-2' }]),
    listBillingUserItems: vi.fn().mockResolvedValue([{ id: 'bill-user-1' }]),
    listBillingPlatformItems: vi.fn().mockResolvedValue([{ id: 'bill-platform-1' }]),
    listBillingAnomalies: vi.fn().mockResolvedValue([{ id: 'anomaly-1' }]),
    syncBilling: vi.fn().mockResolvedValue({ syncedDays: 1, importedLineItems: 2, anomalyCount: 0, deferredCount: 0 }),
    exportPlatformBillingCsv: vi.fn().mockResolvedValue('startAt,2026-07-01\n'),
    exportBillingUsersCsv: vi.fn().mockResolvedValue('userId,username\n'),
    exportBillingUserItemsCsv: vi.fn().mockResolvedValue('billingDate,amount\n'),
    launchRange: vi.fn().mockResolvedValue({ id: 'range-2' }),
    destroyRange: vi.fn().mockResolvedValue({ ok: true }),
    launchSingleInstances: vi.fn().mockResolvedValue({ batch: { id: 'batch-1' }, instances: [] }),
    destroySingleInstance: vi.fn().mockResolvedValue({ ok: true }),
    destroySingleInstanceBatch: vi.fn().mockResolvedValue({ batchId: 'batch-1', jobCount: 2 }),
    retrySingleInstance: vi.fn().mockResolvedValue({ ok: true }),
    rebootSingleInstance: vi.fn().mockResolvedValue({ ok: true }),
    openSingleInstanceVnc: vi.fn().mockResolvedValue({ status: 'accepted', vncUrl: 'wss://vnc' }),
    packSingleInstanceImage: vi.fn().mockResolvedValue({ status: 'accepted', imageId: 'm-1' }),
    getInstanceTypeAvailability: vi.fn().mockResolvedValue({
      cpu: 2,
      memory: 4,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: true,
      matches: [{ instanceTypeId: 'ecs.e-c1m2.large', cpu: 2, memoryGiB: 4, family: 'ecs.e', generation: 'c1', architecture: 'x86' }],
      warning: null,
    }),
  } as ClientStub;
}

describe('tool registry', () => {
  it('publishes every template orchestration tool with a complete MCP definition', () => {
    const registry = createToolRegistry(createClientStub());
    const tools = registry.listTools([
      'templates:read',
      'templates:write',
      'templates:publish',
      'templates:delete',
    ]);
    const expectedNames = [
      'range_template_list',
      'range_template_get',
      'range_template_create',
      'range_template_update',
      'range_template_clone',
      'range_template_topology_detect_and_save',
      'range_template_publish',
      'range_template_unpublish',
      'range_template_delete',
    ];

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(expectedNames));

    for (const name of expectedNames) {
      const tool = tools.find((item) => item.name === name) as Record<string, unknown> | undefined;

      expect(tool).toMatchObject({
        name,
        title: expect.any(String),
        description: expect.any(String),
        inputSchema: expect.anything(),
        outputSchema: expect.anything(),
        annotations: expect.any(Object),
      });
    }

    expect(tools.find((tool) => tool.name === 'range_template_list')?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(tools.find((tool) => tool.name === 'range_template_delete')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it('exposes template authoring tools only with the matching write scope', () => {
    const registry = createToolRegistry(createClientStub());

    expect(registry.listTools(['templates:read']).map((tool) => tool.name)).toContain('range_template_get');
    expect(registry.listTools(['templates:read']).map((tool) => tool.name)).not.toContain('range_template_create');
    expect(registry.listTools(['templates:write']).map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'range_template_create',
        'range_template_update',
        'range_template_topology_detect_and_save',
      ]),
    );
  });

  it('publishes every front-end range-instance operation as a complete MCP tool', () => {
    const registry = createToolRegistry(createClientStub());
    const tools = registry.listTools([
      'ranges:read',
      'ranges:create',
      'ranges:write',
      'ranges:control',
      'ranges:destroy',
      'ranges:delete',
      'instances:credentials:read',
      'templates:write',
      'images:write',
    ]);
    const expectedNames = [
      'range_instance_list',
      'range_instance_get',
      'range_instance_get_access',
      'range_instance_launch',
      'range_instance_topology_save',
      'range_instance_topology_apply',
      'range_instance_sync_template',
      'range_instance_retry',
      'range_instance_node_start',
      'range_instance_node_stop',
      'range_instance_node_reboot',
      'range_instance_node_open_vnc',
      'range_instance_node_pack_image',
      'range_instance_destroy',
      'range_instance_delete_failed',
    ];

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(expectedNames));

    for (const name of expectedNames) {
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        name,
        title: expect.any(String),
        description: expect.any(String),
        inputSchema: expect.anything(),
        outputSchema: expect.anything(),
        annotations: expect.any(Object),
      });
    }
  });

  it('compiles complete instance topology before saving a range-instance change', async () => {
    const client = createClientStub();
    (client.getRangeInstance as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'range-1',
      name: 'Web DMZ 练习环境',
      runtimeScenarioTemplateSpec: {
        metadata: {
          name: 'Web DMZ',
          slug: 'web-dmz',
          version: '1.0.0',
          cloudProvider: 'alibaba_cloud',
          iacType: 'opentofu',
        },
        topology: {
          vpcCidr: '10.0.0.0/16',
        },
      },
    });
    const registry = createToolRegistry(client);

    await registry.callTool('range_instance_topology_save', ['ranges:write'], {
      rangeInstanceId: 'range-1',
      topologyGraph: authoringGraph,
    });

    expect(client.saveRangeInstanceDraft).toHaveBeenCalledWith(
      'range-1',
      expect.objectContaining({
        draftTopologyGraph: authoringGraph,
        draftScenarioTemplateSpec: expect.objectContaining({
          metadata: expect.objectContaining({ slug: 'web-dmz' }),
        }),
        draftCompiledProvisionSpec: expect.any(Object),
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
  });

  it('compiles a new topology graph before forwarding template creation', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await registry.callTool('range_template_create', ['templates:write'], {
      name: 'Web DMZ',
      topologyGraph: authoringGraph,
    });

    expect(client.createRangeTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        topologyGraph: authoringGraph,
        topologySpec: expect.objectContaining({ publicEntry: { hostKey: 'ecs-nginx', protocols: [{ protocol: 'ssh', port: 22 }, { protocol: 'http', port: 80 }] } }),
        scenarioTemplateSpec: expect.objectContaining({ metadata: expect.objectContaining({ name: 'Web DMZ' }) }),
        compiledProvisionSpec: expect.objectContaining({ dnatEntries: [expect.objectContaining({ hostKey: 'ecs-nginx', externalPort: 80 })] }),
        compiledSpec: expect.objectContaining({
          schemaVersion: '1.0.0',
          topology: expect.objectContaining({ publicEntryHostKey: 'ecs-nginx' }),
          resources: expect.arrayContaining([
            expect.objectContaining({ id: 'router-main', type: 'router' }),
            expect.objectContaining({ id: 'switch-dmz', type: 'switch' }),
            expect.objectContaining({ id: 'ecs-nginx', type: 'host' }),
          ]),
        }),
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
  });

  it('creates a template with the API contract instead of caller-supplied server metadata', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await registry.callTool('range_template_create', ['templates:write'], {
      name: 'Web DMZ',
      description: 'Public web entry template',
      primaryVpcCidr: '10.0.0.0/16',
      secondaryVpcCidrs: ['172.16.0.0/16'],
      topologyGraph: authoringGraph,
    });

    const payload = (client.createRangeTemplate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      name: 'Web DMZ',
      description: 'Public web entry template',
      topologyGraph: authoringGraph,
    });
    expect(payload).not.toHaveProperty('slug');
    expect(payload).not.toHaveProperty('version');
    expect(payload).not.toHaveProperty('cloudProvider');
    expect(payload).not.toHaveProperty('iacType');
    expect(payload).not.toHaveProperty('modulePathOrRef');
  });

  it('detects and saves a complete topology only after compilation succeeds', async () => {
    const client = createClientStub();
    (client.getRangeTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(createAuthoringTemplate());
    const registry = createToolRegistry(client);

    await registry.callTool('range_template_topology_detect_and_save', ['templates:write'], {
      templateId: 'tpl-1',
      topologyGraph: authoringGraph,
    });

    expect(client.saveRangeTemplateTopology).toHaveBeenCalledWith(
      'tpl-1',
      expect.objectContaining({
        expectedRevision: 7,
        topologyGraph: authoringGraph,
        topologySpec: expect.objectContaining({
          publicEntry: { hostKey: 'ecs-nginx', protocols: [{ protocol: 'ssh', port: 22 }, { protocol: 'http', port: 80 }] },
        }),
        scenarioTemplateSpec: expect.any(Object),
        compiledProvisionSpec: expect.any(Object),
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
  });

  it('detects and saves a template when public detail hides server-owned metadata', async () => {
    const client = createClientStub();
    const { version: _version, modulePathOrRef: _modulePathOrRef, ...publicTemplate } = createAuthoringTemplate();
    (client.getRangeTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(publicTemplate);
    const registry = createToolRegistry(client);

    await registry.callTool('range_template_topology_detect_and_save', ['templates:write'], {
      templateId: 'tpl-1',
      topologyGraph: authoringGraph,
    });

    expect(client.saveRangeTemplateTopology).toHaveBeenCalledWith(
      'tpl-1',
      expect.objectContaining({
        scenarioTemplateSpec: expect.objectContaining({
          metadata: expect.objectContaining({ version: 'v1' }),
        }),
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
  });

  it('compiles vSwitches from primary and secondary VPC CIDRs before creation', async () => {
    const client = createClientStub();
    const graph = structuredClone(authoringGraph);
    graph.nodes.push(
      {
        id: 'switch-office', kind: 'switch', label: '办公网', zoneKey: 'office', cidr: '192.168.0.0/24', purpose: 'office',
        nat: { snatEnabled: true, dnatMappings: [] }, aclRules: [],
      },
      {
        id: 'switch-server', kind: 'switch', label: '服务网', zoneKey: 'server', cidr: '172.16.0.0/24', purpose: 'server',
        nat: { snatEnabled: true, dnatMappings: [] }, aclRules: [],
      },
      {
        id: 'ecs-office', kind: 'ecs', label: '办公主机', zoneKey: 'office', role: 'workstation', privateIp: '192.168.0.10', exposePublic: false,
        image: 'img-nginx', imageId: 'img-nginx', platformImageAssetId: 'asset-nginx',
        dnatMappings: [], networkInterfaces: [], portGroups: [], initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'img-nginx' }, instanceTypeStrategy: { mode: 'auto' },
        nics: [{ id: 'nic-office', switchId: 'switch-office', privateIp: '192.168.0.10', secondaryIps: [], securityGroupRules: [] }],
      },
      {
        id: 'ecs-server', kind: 'ecs', label: '服务主机', zoneKey: 'server', role: 'server', privateIp: '172.16.0.10', exposePublic: false,
        image: 'img-nginx', imageId: 'img-nginx', platformImageAssetId: 'asset-nginx',
        dnatMappings: [], networkInterfaces: [], portGroups: [], initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'img-nginx' }, instanceTypeStrategy: { mode: 'auto' },
        nics: [{ id: 'nic-server', switchId: 'switch-server', privateIp: '172.16.0.10', secondaryIps: [], securityGroupRules: [] }],
      },
    );
    graph.edges.push(
      { id: 'router-to-switch-office', fromNodeId: 'router-main', toNodeId: 'switch-office', relationType: 'manual' },
      { id: 'router-to-switch-server', fromNodeId: 'router-main', toNodeId: 'switch-server', relationType: 'manual' },
      { id: 'switch-office-to-ecs-office', fromNodeId: 'switch-office', toNodeId: 'ecs-office', relationType: 'manual' },
      { id: 'switch-server-to-ecs-server', fromNodeId: 'switch-server', toNodeId: 'ecs-server', relationType: 'manual' },
    );
    const registry = createToolRegistry(client);

    await registry.callTool('range_template_create', ['templates:write'], {
      name: '三网段靶场',
      primaryVpcCidr: '10.0.0.0/16',
      secondaryVpcCidrs: ['172.16.0.0/16', '192.168.0.0/16'],
      topologyGraph: graph,
    });

    expect(client.createRangeTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        topologySpec: expect.objectContaining({ vpcCidr: '10.0.0.0/16' }),
        scenarioTemplateSpec: expect.objectContaining({
          topology: expect.objectContaining({
            secondaryVpcCidrs: ['172.16.0.0/16', '192.168.0.0/16'],
          }),
        }),
        compiledProvisionSpec: expect.objectContaining({
          topology: expect.objectContaining({
            secondaryVpcCidrs: ['172.16.0.0/16', '192.168.0.0/16'],
          }),
        }),
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
  });

  it('rejects caller-supplied compiled artifacts during template creation', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: 'Web DMZ',
        topologyGraph: authoringGraph,
        compiledProvisionSpec: { forged: true },
      }),
    ).rejects.toThrow('compiledProvisionSpec');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('requires a resolved platform image selection before creating a template', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: '最小靶场',
        topologyGraph: minimalAuthoringGraph,
      }),
    ).rejects.toThrow('platformImageAssetId');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('requires explicit switch NAT and exposes DNAT mappings in the create schema', () => {
    const registry = createToolRegistry(createClientStub());
    const create = registry.listTools(['templates:write']).find((tool) => tool.name === 'range_template_create');
    const graphWithoutNat = structuredClone(authoringGraph);
    const switchNode = graphWithoutNat.nodes.find((node) => node.id === 'switch-dmz');

    if (switchNode?.kind !== 'switch') {
      throw new Error('Expected a switch node');
    }

    delete (switchNode as Partial<typeof switchNode>).nat;

    expect(create?.inputSchema?.safeParse({
      name: '缺少 NAT 的拓扑',
      topologyGraph: graphWithoutNat,
    }).success).toBe(false);

    const serializedSchema = JSON.stringify(create?.inputSchema);
    expect(serializedSchema).toContain('dnatMappings');
    expect(serializedSchema).toContain('targetHostId');
  });

  it('accepts the complete switch ACL shape used by the topology editor', () => {
    const registry = createToolRegistry(createClientStub());
    const graphWithDestinationCidr = structuredClone(authoringGraph);
    const switchNode = graphWithDestinationCidr.nodes.find((node) => node.id === 'switch-dmz');

    if (switchNode?.kind !== 'switch') {
      throw new Error('Expected a switch node');
    }

    switchNode.aclRules = [{
      key: 'dmz-to-internal',
      direction: 'outbound',
      protocol: 'tcp',
      portRange: '443/443',
      sourceCidr: '10.0.0.0/24',
      destinationCidr: '172.16.0.0/24',
      policy: 'allow',
      priority: 10,
    }];

    expect(registry.listTools(['templates:write']).find((tool) => tool.name === 'range_template_create')?.inputSchema.safeParse({
      name: '含 ACL 目标网段的拓扑',
      topologyGraph: graphWithDestinationCidr,
    }).success).toBe(true);
  });

  it('accepts the frontend image display name while keeping image identity fields exact', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    const graph = structuredClone(authoringGraph);
    const host = graph.nodes.find((node) => node.id === 'ecs-nginx');

    if (host?.kind !== 'ecs') {
      throw new Error('Expected an ECS node');
    }

    host.image = '培训渗透靶机';
    host.imageName = '培训渗透靶机';

    await registry.callTool('range_template_create', ['templates:write'], {
      name: '前端镜像字段契约',
      topologyGraph: graph,
    });

    expect(client.createRangeTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        topologyGraph: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 'ecs-nginx',
              image: '培训渗透靶机',
              imageId: 'img-nginx',
              platformImageAssetId: 'asset-nginx',
              imageStrategy: { mode: 'fixed', imageId: 'img-nginx' },
            }),
          ]),
        }),
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
  });

  it('rejects a public entry ECS without a DNAT mapping before creating a template', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    const invalidGraph = structuredClone(authoringGraph);
    const switchNode = invalidGraph.nodes.find((node) => node.id === 'switch-dmz');

    if (switchNode?.kind !== 'switch') {
      throw new Error('Expected a switch node');
    }

    switchNode.nat = { snatEnabled: true, dnatMappings: [] };

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: '缺少入口 DNAT',
        topologyGraph: invalidGraph,
      }),
    ).rejects.toThrow('公网入口 ECS 必须至少配置一条 DNAT：ecs-nginx');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('rejects duplicate logical switch zone keys before creating a template', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    const invalidGraph = structuredClone(authoringGraph);

    invalidGraph.nodes.push({
      id: 'switch-office', kind: 'switch', label: '办公网', zoneKey: 'dmz', cidr: '10.0.1.0/24', purpose: 'office',
      nat: { snatEnabled: true, dnatMappings: [] }, aclRules: [],
    });
    invalidGraph.edges.push({
      id: 'router-to-switch-office', fromNodeId: 'router-main', toNodeId: 'switch-office', relationType: 'manual',
    });

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: '重复逻辑分区',
        topologyGraph: invalidGraph,
      }),
    ).rejects.toThrow('交换机 zoneKey 重复：dmz');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('rejects a topology without the required VPC router', async () => {
    const registry = createToolRegistry(createClientStub());
    const routerlessGraph = structuredClone(authoringGraph);
    routerlessGraph.nodes = routerlessGraph.nodes.filter((node) => node.kind !== 'router');
    routerlessGraph.edges = routerlessGraph.edges.filter((edge) => edge.fromNodeId !== 'router-main');

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: '缺少 Router',
        topologyGraph: routerlessGraph,
      }),
    ).rejects.toThrow('拓扑必须且只能包含一个 Router 节点');
  });

  it('rejects a switch without a Router connection', async () => {
    const registry = createToolRegistry(createClientStub());
    const graph = structuredClone(authoringGraph);
    graph.edges = graph.edges.filter((edge) => edge.fromNodeId !== 'router-main');

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: '缺少 VPC 连线',
        topologyGraph: graph,
      }),
    ).rejects.toThrow('交换机缺少 Router 连线：switch-dmz');
  });

  it('rejects a NIC IP outside its linked switch CIDR before creating a template', async () => {
    const client = createClientStub();
    const invalidGraph = structuredClone(authoringGraph);
    const host = invalidGraph.nodes.find((node) => node.id === 'ecs-nginx')!;

    if (host.kind !== 'ecs') {
      throw new Error('Expected an ECS node');
    }

    host.privateIp = '10.0.1.10';
    host.nics![0]!.privateIp = '10.0.1.10';
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: 'Web DMZ',
        topologyGraph: invalidGraph,
      }),
    ).rejects.toThrow('不在 10.0.0.0/24 网段内');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('rejects a graph with no explicit public entry ECS', async () => {
    const client = createClientStub();
    const invalidGraph = structuredClone(authoringGraph);
    const host = invalidGraph.nodes.find((node) => node.id === 'ecs-nginx')!;

    if (host.kind !== 'ecs') {
      throw new Error('Expected an ECS node');
    }

    host.role = 'host';
    host.exposePublic = false;
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: 'Web DMZ',
        topologyGraph: invalidGraph,
      }),
    ).rejects.toThrow('必须指定一个公网入口 ECS');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('rejects duplicated primary or secondary private IPs in the same switch', async () => {
    const client = createClientStub();
    const invalidGraph = structuredClone(authoringGraph);
    invalidGraph.nodes.push({
      id: 'ecs-duplicate', kind: 'ecs', label: 'Duplicate host', zoneKey: 'dmz', role: 'host', privateIp: '10.0.0.10', exposePublic: false,
      image: 'img-nginx', imageId: 'img-nginx', platformImageAssetId: 'asset-nginx',
      dnatMappings: [], networkInterfaces: [], portGroups: [], initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'img-nginx' }, instanceTypeStrategy: { mode: 'auto' },
      nics: [{ id: 'nic-duplicate', switchId: 'switch-dmz', privateIp: '10.0.0.10', secondaryIps: [], securityGroupRules: [] }],
    });
    invalidGraph.edges.push({ id: 'switch-dmz-to-duplicate', fromNodeId: 'switch-dmz', toNodeId: 'ecs-duplicate', relationType: 'manual' });
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: 'Web DMZ',
        topologyGraph: invalidGraph,
      }),
    ).rejects.toThrow('存在重复 IP：10.0.0.10');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('rejects an ECS edge that is not backed by an ECS NIC bound to that switch', async () => {
    const client = createClientStub();
    const invalidGraph = structuredClone(authoringGraph);
    invalidGraph.nodes.push({
      id: 'switch-internal', kind: 'switch', label: 'Internal switch', zoneKey: 'internal', cidr: '10.0.1.0/24', purpose: 'internal',
      nat: { snatEnabled: false, dnatMappings: [] }, aclRules: [],
    });
    invalidGraph.edges.push({ id: 'switch-internal-to-nginx', fromNodeId: 'switch-internal', toNodeId: 'ecs-nginx', relationType: 'manual' });
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: 'Web DMZ',
        topologyGraph: invalidGraph,
      }),
    ).rejects.toThrow('未由目标 ECS 的 NIC 绑定支撑');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('rejects an ECS custom password that violates the Alibaba Cloud password policy', async () => {
    const client = createClientStub();
    const invalidGraph = structuredClone(authoringGraph);
    const host = invalidGraph.nodes.find((node) => node.id === 'ecs-nginx')!;

    if (host.kind !== 'ecs') {
      throw new Error('Expected an ECS node');
    }

    host.customPassword = 'onlylowercase';
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: 'Web DMZ',
        topologyGraph: invalidGraph,
      }),
    ).rejects.toThrow('自定义密码不合法');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('redacts template custom passwords from a read-only MCP response', async () => {
    const client = createClientStub();
    const graph = structuredClone(authoringGraph);
    const host = graph.nodes.find((node) => node.id === 'ecs-nginx')!;

    if (host.kind !== 'ecs') {
      throw new Error('Expected an ECS node');
    }

    host.customPassword = 'SecretPass123!';
    (client.getRangeTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(createAuthoringTemplate(graph));
    const registry = createToolRegistry(client);

    const result = await registry.callTool('range_template_get', ['templates:read'], { templateId: 'tpl-1' });

    expect(JSON.stringify(result)).not.toContain('SecretPass123!');
    expect(JSON.stringify(result)).not.toContain('customPassword');
  });

  it('redacts custom passwords from detection-and-save results', async () => {
    const graph = structuredClone(authoringGraph);
    const host = graph.nodes.find((node) => node.id === 'ecs-nginx')!;

    if (host.kind !== 'ecs') {
      throw new Error('Expected an ECS node');
    }

    host.customPassword = 'SecretPass123!';
    const client = createClientStub();
    (client.getRangeTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(createAuthoringTemplate(graph));
    const registry = createToolRegistry(client);

    const result = await registry.callTool('range_template_topology_detect_and_save', ['templates:write'], {
      templateId: 'tpl-1',
      topologyGraph: graph,
    });

    expect(JSON.stringify(result)).not.toContain('SecretPass123!');
    expect(JSON.stringify(result)).not.toContain('customPassword');
  });

  it('preserves a redacted custom password during a whole-graph replacement unless explicitly changed', async () => {
    const client = createClientStub();
    const storedGraph = structuredClone(authoringGraph);
    const storedHost = storedGraph.nodes.find((node) => node.id === 'ecs-nginx')!;

    if (storedHost.kind !== 'ecs') {
      throw new Error('Expected an ECS node');
    }

    storedHost.customPassword = 'SecretPass123!';
    (client.getRangeTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(createAuthoringTemplate(storedGraph));
    const registry = createToolRegistry(client);

    await registry.callTool('range_template_topology_detect_and_save', ['templates:write'], {
      templateId: 'tpl-1',
      topologyGraph: structuredClone(authoringGraph),
    });

    expect(client.saveRangeTemplateTopology).toHaveBeenCalledWith(
      'tpl-1',
      expect.objectContaining({
        expectedRevision: 7,
        topologyGraph: expect.objectContaining({
          nodes: expect.arrayContaining([expect.objectContaining({ id: 'ecs-nginx', customPassword: 'SecretPass123!' })]),
        }),
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
  });

  it('publishes structured schemas for the frontend template workflows', () => {
    const registry = createToolRegistry(createClientStub());
    const tools = registry.listTools(['templates:write']);
    const create = tools.find((tool) => tool.name === 'range_template_create');
    const update = tools.find((tool) => tool.name === 'range_template_update');
    const detectAndSave = tools.find((tool) => tool.name === 'range_template_topology_detect_and_save');

    expect(create?.inputSchema).toBeDefined();
    expect(update?.inputSchema).toBeDefined();
    expect(detectAndSave?.inputSchema).toBeDefined();
    expect(create?.inputSchema?.safeParse({ name: 'only-a-name' }).success).toBe(false);
    expect(create?.inputSchema?.safeParse({ name: 'Web DMZ', topologyGraph: authoringGraph }).success).toBe(true);
    expect(
      create?.inputSchema?.safeParse({
        name: 'Web DMZ',
        slug: 'caller-must-not-set-this',
        topologyGraph: authoringGraph,
      }).success,
    ).toBe(false);
    expect(update?.inputSchema?.safeParse({ templateId: 'tpl-1', updates: { compiledProvisionSpec: { forged: true } } }).success).toBe(false);
    expect(detectAndSave?.inputSchema?.safeParse({ templateId: 'tpl-1' }).success).toBe(false);
  });

  it('publishes a structured input schema for every exposed tool', () => {
    const registry = createToolRegistry(createClientStub());
    const scopes = [
      'templates:read', 'templates:write', 'templates:publish', 'templates:delete',
      'images:read', 'images:write', 'ranges:read', 'ranges:create', 'ranges:write', 'ranges:control', 'ranges:destroy', 'ranges:delete',
      'instances:read', 'instances:create', 'instances:destroy', 'instances:control', 'instances:credentials:read',
      'jobs:read', 'users:read', 'users:write', 'billing:read', 'billing:sync', 'settings:read', 'settings:write',
    ];

    const tools = registry.listTools(scopes);

    expect(tools).toHaveLength(69);
    expect(tools.every((tool) => tool.inputSchema)).toBe(true);
    expect(tools.every((tool) => tool.outputSchema?.safeParse({}).success === false)).toBe(true);
    expect(
      tools
        .filter((tool) => !/[^\x00-\x7F]/.test(tool.title) || !/[^\x00-\x7F]/.test(tool.description))
        .map((tool) => tool.name),
    ).toEqual([]);
  });

  it('exposes every safe-to-automate image-center action from the frontend', () => {
    const registry = createToolRegistry(createClientStub());
    const tools = registry.listTools(['images:read', 'images:write']);
    const expectedNames = [
      'image_catalog_list',
      'image_catalog_sync',
      'image_catalog_custom_delete',
      'image_import_job_list',
      'image_import_job_retry',
    ];

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(expectedNames));

    for (const name of expectedNames) {
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        name,
        title: expect.any(String),
        description: expect.stringMatching(/[^\x00-\x7F]/),
        inputSchema: expect.anything(),
        outputSchema: expect.anything(),
        annotations: expect.any(Object),
      });
    }
  });

  it('exposes every billing page action with a scoped MCP definition', () => {
    const registry = createToolRegistry(createClientStub());
    const tools = registry.listTools(['billing:read', 'billing:sync']);
    const expectedNames = [
      'billing_summary_get',
      'billing_user_list',
      'billing_user_summary_get',
      'billing_user_group_list',
      'billing_platform_group_list',
      'billing_user_item_list',
      'billing_platform_item_list',
      'billing_anomaly_list',
      'billing_sync',
      'billing_export_platform_csv',
      'billing_export_users_csv',
      'billing_export_user_csv',
    ];

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(expectedNames));

    for (const name of expectedNames) {
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        name,
        title: expect.any(String),
        description: expect.stringMatching(/[^\x00-\x7F]/),
        inputSchema: expect.anything(),
        outputSchema: expect.anything(),
        annotations: expect.any(Object),
      });
    }
  });

  it('returns a result envelope for arrays and objects', async () => {
    const registry = createToolRegistry(createClientStub());

    await expect(registry.callTool('platform_image_list', ['images:read'], {})).resolves.toMatchObject({
      structuredContent: {
        result: [{ id: 'img-1' }],
      },
      content: [{ type: 'text', text: expect.stringContaining('"result"') }],
    });
  });

  it('rejects caller-supplied derived fields during a template update', async () => {
    const registry = createToolRegistry(createClientStub());

    await expect(
      registry.callTool('range_template_update', ['templates:write'], {
        templateId: 'tpl-1',
        updates: { compiledProvisionSpec: { forged: true } },
      }),
    ).rejects.toThrow('compiledProvisionSpec');
  });

  it('filters tools by scopes', () => {
    const registry = createToolRegistry(createClientStub());
    const tools = registry.listTools(['templates:read', 'instances:read']);

    expect(tools.map((tool) => tool.name)).toContain('range_template_list');
    expect(tools.map((tool) => tool.name)).toContain('single_instance_get');
    expect(tools.map((tool) => tool.name)).not.toContain('single_instance_destroy');
  });

  it('maps mutation tools to client calls', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await registry.callTool('range_instance_launch', ['ranges:create'], {
      templateId: 'tpl-1',
      name: 'range-a',
      expiresAt: '2026-07-20T00:00:00.000Z',
      idempotencyKey: 'idem-1',
      confirmationId: 'confirm-1',
    });

    expect(client.launchRange).toHaveBeenCalledWith(
      { templateId: 'tpl-1', name: 'range-a', expiresAt: '2026-07-20T00:00:00.000Z' },
      { idempotencyKey: 'idem-1', confirmationId: 'confirm-1' },
    );
  });

  it('normalizes confirmed range lifecycle results to stable resource IDs', async () => {
    const client = createClientStub();
    (client.launchRange as ReturnType<typeof vi.fn>).mockResolvedValue({
      rangeInstanceId: 'range-2',
      jobId: 'job-2',
    });
    (client.syncRangeInstanceTemplate as ReturnType<typeof vi.fn>).mockResolvedValue({
      rangeInstanceId: 'range-2',
      templateId: 'tpl-2',
    });
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('range_instance_launch', ['ranges:create'], {
        templateId: 'tpl-1',
        name: 'range-a',
        expiresAt: '2026-07-20T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      structuredContent: { result: { id: 'range-2', jobId: 'job-2' } },
    });

    await expect(
      registry.callTool('range_instance_sync_template', ['ranges:write', 'templates:write'], {
        rangeInstanceId: 'range-2',
        topologyGraph: authoringGraph,
      }),
    ).resolves.toMatchObject({
      structuredContent: { result: { id: 'tpl-2', rangeInstanceId: 'range-2' } },
    });
  });

  it('keeps cloud-config operation metadata out of the configuration payload', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await registry.callTool('cloud_config_update', ['settings:write'], {
      defaultRegion: 'cn-shanghai',
      idempotencyKey: 'config-update-1',
      confirmationId: 'confirm-1',
    });

    expect(client.saveCloudConfig).toHaveBeenCalledWith(
      { defaultRegion: 'cn-shanghai' },
      { idempotencyKey: 'config-update-1', confirmationId: 'confirm-1' },
    );
  });

  it('keeps admin-user operation metadata out of the user payload', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await registry.callTool('admin_user_create', ['users:write'], {
      username: 'mcp-test-user',
      password: 'TestPassword123!',
      role: 'user',
      idempotencyKey: 'user-create-1',
      confirmationId: 'confirm-1',
    });

    expect(client.createAdminUser).toHaveBeenCalledWith(
      { username: 'mcp-test-user', password: 'TestPassword123!', role: 'user' },
      { idempotencyKey: 'user-create-1', confirmationId: 'confirm-1' },
    );
  });

  it('returns a structured confirmation requirement', async () => {
    const client = createClientStub();
    (client.launchRange as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PlatformApiError(409, 'confirmation required', {
        message: { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirm-1', idempotencyKey: 'idem-1' },
      }),
    );
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('range_instance_launch', ['ranges:create'], {
        templateId: 'tpl-1',
        name: 'range-a',
        expiresAt: '2026-07-20T00:00:00.000Z',
        idempotencyKey: 'idem-1',
      }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        result: {
          error: { message: { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirm-1', idempotencyKey: 'idem-1' } },
        },
      },
    });
  });

  it('opens vnc without confirmation fields', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    const result = await registry.callTool('single_instance_open_vnc', ['instances:control', 'instances:credentials:read'], {
      singleInstanceId: 'ins-1',
    });

    expect(client.openSingleInstanceVnc).toHaveBeenCalledWith('ins-1', {
      displayName: undefined,
      defaultHostName: undefined,
      defaultPassword: undefined,
      description: undefined,
    });
    expect(result.structuredContent).toEqual({ result: { status: 'accepted', vncUrl: 'wss://vnc' } });
  });

  it('exports a single instance batch as csv', async () => {
    const registry = createToolRegistry(createClientStub());

    const result = await registry.callTool('single_instance_batch_export_csv', ['instances:read', 'instances:credentials:read'], {
      batchId: 'batch-1',
    });

    expect(result.structuredContent).toEqual({
      result: {
        batchId: 'batch-1',
        batchName: 'batch-a',
        fileName: 'batch-a-instances.csv',
        rowCount: 1,
        csv: '实例名,公网 IP,账号,密码\nins-1,1.1.1.1,root,secret',
      },
    });
  });

  it('exposes a read-only single-instance specification check', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    expect(registry.listTools(['instances:read']).map((tool) => tool.name)).toContain('single_instance_spec_check');

    await expect(
      registry.callTool('single_instance_spec_check', ['instances:read'], { cpu: 2, memory: 4 }),
    ).resolves.toMatchObject({
      structuredContent: {
        result: {
          exactAvailable: true,
          matches: [{ instanceTypeId: 'ecs.e-c1m2.large' }],
        },
      },
    });
    expect(client.getInstanceTypeAvailability).toHaveBeenCalledWith(2, 4);
  });

  it('checks availability before forwarding a single-instance launch', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await registry.callTool('single_instance_batch_launch', ['instances:read', 'instances:create'], {
      name: 'training-host',
      platformImageAssetId: 'img-1',
      cpu: 2,
      memory: 4,
      expiresAt: '2026-07-20T00:00:00.000Z',
      quantity: 1,
    });

    expect(client.getInstanceTypeAvailability).toHaveBeenCalledWith(2, 4);
    expect(client.launchSingleInstances).toHaveBeenCalledTimes(1);
    expect(client.getInstanceTypeAvailability.mock.invocationCallOrder[0]).toBeLessThan(
      (client.launchSingleInstances as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
  });

  it('does not forward a single-instance launch when the specification is unavailable', async () => {
    const client = createClientStub();
    client.getInstanceTypeAvailability.mockResolvedValue({
      cpu: 2,
      memory: 4,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: false,
      matches: [],
      warning: '当前默认可用区没有精确匹配规格。',
    });
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('single_instance_batch_launch', ['instances:read', 'instances:create'], {
        name: 'training-host',
        platformImageAssetId: 'img-1',
        cpu: 2,
        memory: 4,
        expiresAt: '2026-07-20T00:00:00.000Z',
        quantity: 1,
      }),
    ).rejects.toThrow('当前默认可用区没有精确匹配规格。');
    expect(client.launchSingleInstances).not.toHaveBeenCalled();
  });

  it('does not forward a single-instance launch when the specification check fails', async () => {
    const client = createClientStub();
    client.getInstanceTypeAvailability.mockRejectedValue(new Error('规格校验服务暂不可用'));
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('single_instance_batch_launch', ['instances:read', 'instances:create'], {
        name: 'training-host',
        platformImageAssetId: 'img-1',
        cpu: 2,
        memory: 4,
        expiresAt: '2026-07-20T00:00:00.000Z',
        quantity: 1,
      }),
    ).rejects.toThrow('规格校验服务暂不可用');
    expect(client.launchSingleInstances).not.toHaveBeenCalled();
  });
});
