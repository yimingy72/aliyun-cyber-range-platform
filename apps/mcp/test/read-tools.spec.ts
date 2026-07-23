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
      image: 'img-nginx', dnatMappings: [], networkInterfaces: [], portGroups: [], initScript: '',
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
    validateRangeTemplate: vi.fn().mockResolvedValue({ valid: true }),
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
      name: 'Web DMZ', slug: 'web-dmz', version: '1.0.0', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
      modulePathOrRef: 'modules/enterprise-range', topologyGraph: authoringGraph,
    });

    expect(client.createRangeTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        topologyGraph: authoringGraph,
        topologySpec: expect.objectContaining({ publicEntry: { hostKey: 'ecs-nginx', protocols: [{ protocol: 'ssh', port: 22 }, { protocol: 'http', port: 80 }] } }),
        scenarioTemplateSpec: expect.objectContaining({ metadata: expect.objectContaining({ slug: 'web-dmz' }) }),
        compiledProvisionSpec: expect.objectContaining({ dnatEntries: [expect.objectContaining({ hostKey: 'ecs-nginx', externalPort: 80 })] }),
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
  });

  it('detects and saves a complete topology only after compilation succeeds', async () => {
    const client = createClientStub();
    (client.getRangeTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(createAuthoringTemplate());
    const registry = createToolRegistry(client);

    await registry.callTool('range_template_topology_detect_and_save', ['templates:write'], {
      templateId: 'tpl-1',
      topologyGraph: authoringGraph,
    });

    expect(client.updateRangeTemplate).toHaveBeenCalledWith(
      'tpl-1',
      expect.objectContaining({
        topologyGraph: authoringGraph,
        topologySpec: expect.objectContaining({
          publicEntry: { hostKey: 'ecs-nginx', protocols: [{ protocol: 'ssh', port: 22 }, { protocol: 'http', port: 80 }] },
        }),
        scenarioTemplateSpec: expect.any(Object),
        compiledProvisionSpec: expect.any(Object),
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
    expect(client.validateRangeTemplate).toHaveBeenCalledWith(
      'tpl-1',
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
        image: 'img-nginx', dnatMappings: [], networkInterfaces: [], portGroups: [], initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'img-nginx' }, instanceTypeStrategy: { mode: 'auto' },
        nics: [{ id: 'nic-office', switchId: 'switch-office', privateIp: '192.168.0.10', secondaryIps: [], securityGroupRules: [] }],
      },
      {
        id: 'ecs-server', kind: 'ecs', label: '服务主机', zoneKey: 'server', role: 'server', privateIp: '172.16.0.10', exposePublic: false,
        image: 'img-nginx', dnatMappings: [], networkInterfaces: [], portGroups: [], initScript: '',
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
      slug: 'three-zone-range',
      version: 'v1',
      cloudProvider: 'alibaba_cloud',
      iacType: 'opentofu',
      modulePathOrRef: 'modules/enterprise-range',
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
        slug: 'web-dmz',
        version: '1.0.0',
        cloudProvider: 'alibaba_cloud',
        iacType: 'opentofu',
        modulePathOrRef: 'modules/enterprise-range',
        topologyGraph: authoringGraph,
        compiledProvisionSpec: { forged: true },
      }),
    ).rejects.toThrow('compiledProvisionSpec');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('normalizes the documented minimum topology graph before creation', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await registry.callTool('range_template_create', ['templates:write'], {
      name: '最小靶场', slug: 'minimal-range', version: '1.0.0', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
      modulePathOrRef: 'modules/enterprise-range', topologyGraph: minimalAuthoringGraph,
    });

    expect(client.createRangeTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        topologyGraph: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 'ecs-entry',
              initScript: '',
              dnatMappings: [],
              networkInterfaces: [],
              portGroups: [],
              imageStrategy: { mode: 'fixed', imageId: 'm-entry-image' },
              instanceTypeStrategy: { mode: 'auto' },
              nics: [expect.objectContaining({ secondaryIps: [], securityGroupRules: [] })],
            }),
          ]),
        }),
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
  });

  it('rejects a topology without the required VPC router', async () => {
    const registry = createToolRegistry(createClientStub());
    const routerlessGraph = structuredClone(authoringGraph);
    routerlessGraph.nodes = routerlessGraph.nodes.filter((node) => node.kind !== 'router');
    routerlessGraph.edges = routerlessGraph.edges.filter((edge) => edge.fromNodeId !== 'router-main');

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: '缺少 Router', slug: 'missing-router', version: '1.0.0', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
        modulePathOrRef: 'modules/enterprise-range', topologyGraph: routerlessGraph,
      }),
    ).rejects.toThrow('拓扑必须且只能包含一个 Router 节点');
  });

  it('rejects a switch without a Router connection', async () => {
    const registry = createToolRegistry(createClientStub());
    const graph = structuredClone(authoringGraph);
    graph.edges = graph.edges.filter((edge) => edge.fromNodeId !== 'router-main');

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: '缺少 VPC 连线', slug: 'missing-router-edge', version: '1.0.0', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
        modulePathOrRef: 'modules/enterprise-range', topologyGraph: graph,
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
        name: 'Web DMZ', slug: 'web-dmz', version: '1.0.0', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
        modulePathOrRef: 'modules/enterprise-range', topologyGraph: invalidGraph,
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
        name: 'Web DMZ', slug: 'web-dmz', version: '1.0.0', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
        modulePathOrRef: 'modules/enterprise-range', topologyGraph: invalidGraph,
      }),
    ).rejects.toThrow('必须指定一个公网入口 ECS');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('rejects duplicated primary or secondary private IPs in the same switch', async () => {
    const client = createClientStub();
    const invalidGraph = structuredClone(authoringGraph);
    invalidGraph.nodes.push({
      id: 'ecs-duplicate', kind: 'ecs', label: 'Duplicate host', zoneKey: 'dmz', role: 'host', privateIp: '10.0.0.10', exposePublic: false,
      image: 'img-nginx', dnatMappings: [], networkInterfaces: [], portGroups: [], initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'img-nginx' }, instanceTypeStrategy: { mode: 'auto' },
      nics: [{ id: 'nic-duplicate', switchId: 'switch-dmz', privateIp: '10.0.0.10', secondaryIps: [], securityGroupRules: [] }],
    });
    invalidGraph.edges.push({ id: 'switch-dmz-to-duplicate', fromNodeId: 'switch-dmz', toNodeId: 'ecs-duplicate', relationType: 'manual' });
    const registry = createToolRegistry(client);

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: 'Web DMZ', slug: 'web-dmz', version: '1.0.0', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
        modulePathOrRef: 'modules/enterprise-range', topologyGraph: invalidGraph,
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
        name: 'Web DMZ', slug: 'web-dmz', version: '1.0.0', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
        modulePathOrRef: 'modules/enterprise-range', topologyGraph: invalidGraph,
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
        name: 'Web DMZ', slug: 'web-dmz', version: '1.0.0', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
        modulePathOrRef: 'modules/enterprise-range', topologyGraph: invalidGraph,
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

    expect(client.updateRangeTemplate).toHaveBeenCalledWith(
      'tpl-1',
      expect.objectContaining({
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
    expect(update?.inputSchema?.safeParse({ templateId: 'tpl-1', updates: { compiledProvisionSpec: { forged: true } } }).success).toBe(false);
    expect(detectAndSave?.inputSchema?.safeParse({ templateId: 'tpl-1' }).success).toBe(false);
  });

  it('publishes a structured input schema for every exposed tool', () => {
    const registry = createToolRegistry(createClientStub());
    const scopes = [
      'templates:read', 'templates:write', 'templates:publish', 'templates:delete',
      'images:read', 'images:write', 'ranges:read', 'ranges:create', 'ranges:write', 'ranges:control', 'ranges:destroy', 'ranges:delete',
      'instances:read', 'instances:create', 'instances:destroy', 'instances:control', 'instances:credentials:read',
      'jobs:read', 'users:read', 'users:write', 'settings:read', 'settings:write',
    ];

    expect(registry.listTools(scopes).every((tool) => tool.inputSchema)).toBe(true);
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
        error: { message: { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirm-1', idempotencyKey: 'idem-1' } },
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
    expect(result.structuredContent).toEqual({ status: 'accepted', vncUrl: 'wss://vnc' });
  });

  it('exports a single instance batch as csv', async () => {
    const registry = createToolRegistry(createClientStub());

    const result = await registry.callTool('single_instance_batch_export_csv', ['instances:read', 'instances:credentials:read'], {
      batchId: 'batch-1',
    });

    expect(result.structuredContent).toEqual({
      batchId: 'batch-1',
      batchName: 'batch-a',
      fileName: 'batch-a-instances.csv',
      rowCount: 1,
      csv: '实例名,公网 IP,账号,密码\nins-1,1.1.1.1,root,secret',
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
        exactAvailable: true,
        matches: [{ instanceTypeId: 'ecs.e-c1m2.large' }],
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
