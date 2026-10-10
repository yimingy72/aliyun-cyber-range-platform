import { describe, expect, it, vi } from 'vitest';

import { PlatformApiClient, PlatformApiError, type PlatformApiClientLike } from '@aliyun-cyber-range/platform-api-client';
import {
  resolveUniqueDnatEntryHost,
  type ScenarioGraphDraft,
} from '@aliyun-cyber-range/scenario-runtime';

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
      id: 'ecs-nginx', kind: 'ecs', label: 'Nginx', zoneKey: 'dmz', role: 'web', privateIp: '10.0.0.10', exposePublic: false,
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

describe('resolveUniqueDnatEntryHost', () => {
  it('exposes controlled fixed DNS readback with strict IDs and forwards the exact confirmation replay', async () => {
    const client = createClientStub();
    const verification = { status: 'failed', method: 'readback', expected: [{ nicId: 'nic-1', privateIp: '10.0.50.20', servers: ['10.0.50.10'] }], actual: [], resolutionStatus: 'not_requested' };
    const action = vi.mocked(client.runRangeInstanceNodeAction);
    action.mockRejectedValueOnce(new PlatformApiError(409, 'confirmation required', { code: 'CONFIRMATION_REQUIRED', confirmationId: 'dns-confirm', idempotencyKey: 'dns-request' }))
      .mockResolvedValue({ status: 'failed', action: 'verify-dns', dnsVerification: verification });
    const registry = createToolRegistry(client);
    const tool = registry.listTools(['ranges:control']).find((item) => item.name === 'range_instance_node_verify_dns')!;
    expect(tool.annotations?.destructiveHint).toBe(false);
    await expect(registry.callTool(tool.name, ['ranges:read'], { rangeInstanceId: 'range-1', nodeId: 'host-1' })).rejects.toThrow('Forbidden tool');
    for (const extra of [{ command: 'whoami' }, { instanceId: 'ins-other' }, { displayName: 'irrelevant' }]) {
      await expect(registry.callTool(tool.name, ['ranges:control'], { rangeInstanceId: 'range-1', nodeId: 'host-1', ...extra })).rejects.toThrow('Invalid input');
    }
    await expect(registry.callTool(tool.name, ['ranges:control'], { rangeInstanceId: 'range-1', nodeId: 'host-1' })).resolves.toMatchObject({ isError: true, structuredContent: { result: { error: { code: 'CONFIRMATION_REQUIRED', confirmationId: 'dns-confirm' } } } });
    await expect(registry.callTool(tool.name, ['ranges:control'], { rangeInstanceId: 'range-1', nodeId: 'host-1', confirmationId: 'dns-confirm', idempotencyKey: 'dns-request' }))
      .resolves.toMatchObject({ structuredContent: { result: { action: 'verify-dns', dnsVerification: verification } } });
    expect(action).toHaveBeenLastCalledWith('range-1', 'host-1', 'verify-dns', {}, { confirmationId: 'dns-confirm', idempotencyKey: 'dns-request' });
    expect(action).toHaveBeenCalledTimes(2);
    expect(client.retryRangeInstance).not.toHaveBeenCalled();
    expect(client.launchRange).not.toHaveBeenCalled();
  });
  it('preserves destroyed range pack artifacts and empty original-disk receipts through the actual SDK and MCP path', async () => {
    const fetchMock=vi.fn(async(input:string,init?:RequestInit)=>{
      expect(input).toBe('https://platform.example/admin/ranges/range%2Fsource'); expect(init?.method).toBe('GET');
      return new Response(JSON.stringify({id:'range/source',status:'destroyed',resourceSummary:null,runtimeCredentials:{entry:{password:'private-password'}},
        packedImageArtifacts:[{id:'artifact-source',status:'creating',phase:'create_image',cloudErrorCode:'InvalidParameterValue',cloudParameterName:'TagSpecification',cloudErrorHint:'invalid_value'}],
        packSourceSnapshots:[{artifactId:'artifact-source',status:'absent',ownership:'unconfirmed',sourceDisks:[{sourceDiskId:'disk-source',status:'absent',candidateSnapshots:[],
          evidence:[{provider:'tencent_cloud',action:'DescribeSnapshots',requestIds:['original-disk-receipt']}]}]}]}));
    });
    const registry=createToolRegistry(new PlatformApiClient({baseUrl:'https://platform.example',token:'synthetic-token',fetch:fetchMock as typeof fetch}));
    const result=await registry.callTool('range_instance_get',['ranges:read'],{rangeInstanceId:'range/source'});
    expect(result).toMatchObject({structuredContent:{result:{packedImageArtifacts:[{id:'artifact-source',cloudParameterName:'TagSpecification'}],
      packSourceSnapshots:[{artifactId:'artifact-source',sourceDisks:[{evidence:[{requestIds:['original-disk-receipt']}]}]}]}}});
    expect(JSON.stringify(result)).not.toContain('private-password'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('exposes distinct read-only Tencent pack validation without creating a real pack request', async () => {
    const client = createClientStub();
    client.validateRangeInstanceNodePackImage = vi.fn().mockResolvedValue({status:'rejected',dryRun:true,cloudParameterName:'TagSpecification',cloudErrorHint:'invalid_value',cloudRequestId:'dry-run-receipt'});
    const registry = createToolRegistry(client);
    const scopes = ['ranges:read','images:read'];
    const tool = registry.listTools(scopes).find(tool=>tool.name==='range_instance_node_pack_image_validate')!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    await expect(registry.callTool(tool.name,scopes,{rangeInstanceId:'range-1',nodeId:'host',displayName:'Exact image',description:'Exact description'}))
      .resolves.toMatchObject({structuredContent:{result:{dryRun:true,cloudParameterName:'TagSpecification'}}});
    expect(client.validateRangeInstanceNodePackImage).toHaveBeenCalledWith('range-1','host',{displayName:'Exact image',description:'Exact description'});
    expect(client.runRangeInstanceNodeAction).not.toHaveBeenCalled();
    await expect(registry.callTool(tool.name,['ranges:read'],{rangeInstanceId:'range-1',nodeId:'host',displayName:'Exact image'})).rejects.toThrow('Forbidden tool');
    await expect(registry.callTool(tool.name,scopes,{rangeInstanceId:'range-1',nodeId:'host',displayName:'Exact image',DryRun:false})).rejects.toThrow('Invalid input');
  });
  it('forwards owned-image cleanup consent and confirmation while preserving the verified cloud result', async () => {
    const client = createClientStub();
    vi.mocked(client.removeCustomImageSnapshot).mockResolvedValue({ removed: true, status: 'deleted', snapshotId: 'source-new', snapshotIds: ['s-new'], deletedSnapshotIds: ['s-new'] });
    const registry = createToolRegistry(client);
    await expect(registry.callTool('image_catalog_custom_delete', ['images:write'], { snapshotId: 'source-new', deleteOwnedSnapshots: true, idempotencyKey: 'cleanup-new', confirmationId: 'confirmed-new' })).resolves.toMatchObject({ structuredContent: { result: { removed: true, status: 'deleted', snapshotIds: ['s-new'] } } });
    expect(client.removeCustomImageSnapshot).toHaveBeenCalledWith('source-new', { deleteOwnedSnapshots: true }, { idempotencyKey: 'cleanup-new', confirmationId: 'confirmed-new' });
  });

  it('ignores a DNAT mapping without a target ECS id', () => {
    const graph = structuredClone(authoringGraph);
    const switchNode = graph.nodes.find((node) => node.id === 'switch-dmz');

    if (switchNode?.kind !== 'switch' || !switchNode.nat) {
      throw new Error('Expected a switch node');
    }

    switchNode.nat.dnatMappings[0]!.targetHostId = ' ';

    expect(resolveUniqueDnatEntryHost(graph.nodes)).toEqual({ kind: 'missing' });
  });
});

function addEcsNode(
  graph: ScenarioGraphDraft,
  input: {
    id: string;
    label: string;
    zoneKey: string;
    switchId: string;
    privateIp: string;
    role?: string;
    exposePublic?: boolean;
  },
) {
  graph.nodes.push({
    id: input.id,
    kind: 'ecs',
    label: input.label,
    zoneKey: input.zoneKey,
    role: input.role ?? 'host',
    privateIp: input.privateIp,
    exposePublic: input.exposePublic ?? false,
    image: 'img-nginx',
    imageId: 'img-nginx',
    platformImageAssetId: 'asset-nginx',
    dnatMappings: [],
    networkInterfaces: [],
    portGroups: [],
    initScript: '',
    imageStrategy: { mode: 'fixed', imageId: 'img-nginx' },
    instanceTypeStrategy: { mode: 'auto' },
    nics: [{
      id: `nic-${input.id}`,
      switchId: input.switchId,
      privateIp: input.privateIp,
      secondaryIps: [],
      securityGroupRules: [],
    }],
  });
  graph.edges.push({
    id: `${input.switchId}-to-${input.id}`,
    fromNodeId: input.switchId,
    toNodeId: input.id,
    relationType: 'manual',
  });
}

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
    returnRangeTemplateToPrivate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    removeRangeTemplate: vi.fn().mockResolvedValue(undefined),
    listPlatformImages: vi.fn().mockResolvedValue([{ id: 'img-1' }]),
    listPlatformImageTags: vi.fn().mockResolvedValue([{ id: 'tag-1', name: 'Web' }]),
    createPlatformImageTag: vi.fn().mockResolvedValue({ id: 'tag-2', name: 'Service' }),
    setPlatformImageTags: vi.fn().mockResolvedValue({ id: 'img-1', tags: [] }),
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
    previewRangeInstanceDraft: vi.fn(),
    saveRangeInstanceAsTemplate: vi.fn(),
    syncRangeInstanceTemplate: vi.fn().mockResolvedValue({ id: 'tpl-1' }),
    retryRangeInstance: vi.fn().mockResolvedValue({ id: 'job-1' }),
    runRangeInstanceNodeAction: vi.fn().mockResolvedValue({ status: 'accepted' }),
    listSingleInstances: vi.fn().mockResolvedValue({ batches: [{ batch: { id: 'batch-1', name: 'batch-a' }, instances: [{ id: 'ins-1', name: 'ins-1', accessEntry: { publicIp: '1.1.1.1' }, runtimeCredentials: { 'single-ecs-1': { username: 'root', password: 'secret' } }, singleInstanceConfig: { hostKey: 'single-ecs-1', imageDisplayName: 'Ubuntu 24.04' } }] }], standaloneInstances: [{ id: 'ins-1' }] }),
    getSingleInstance: vi.fn().mockResolvedValue({ id: 'ins-1' }),
    getSingleInstanceCloudResourceStatus: vi.fn().mockResolvedValue({
      singleInstanceId: 'ins-1',
      regionId: 'cn-hangzhou',
      exists: false,
      instanceIds: [],
      checkedAt: '2026-07-29T00:00:00.000Z',
    }),
    getSingleInstanceAccess: vi.fn().mockResolvedValue({ runtimeCredentials: {} }),
    listProvisionJobs: vi.fn().mockResolvedValue([{ id: 'job-1' }]),
    getProvisionJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
    fetchCloudConfig: vi.fn().mockResolvedValue({ provider: 'alibaba_cloud' }),
    saveCloudConfig: vi.fn().mockResolvedValue({ provider: 'alibaba_cloud', defaultRegion: 'cn-hangzhou' }),
    listCloudAccountContexts: vi.fn().mockResolvedValue([]),
    listCloudWorkspaces: vi.fn().mockResolvedValue([]),
    getCurrentCloudWorkspace: vi.fn().mockResolvedValue({ id: 'fixture-ali-workspace', provider: 'alibaba_cloud', accountUid: '100001', isReadOnly: false, activeCloudAccountContextId: 'fixture-context', contexts: [{ id: 'fixture-context', provider: 'alibaba_cloud', accountUid: '100001', status: 'ready' }], capabilities: { provisioning: true, imageImport: true, billingSync: true } }),
    switchCloudWorkspace: vi.fn(),
    deleteCloudWorkspace: vi.fn(),
    saveCloudAccountBinding: vi.fn(),
    saveTencentCloudAccount: vi.fn(),
    discoverTencentCloudRegions: vi.fn(),
    listTencentCloudImages: vi.fn(),
    getCloudAccountInstanceTypeAvailability: vi.fn(),
    listAdminUsers: vi.fn().mockResolvedValue([{ id: 'user-1', username: 'alice' }]),
    createAdminUser: vi.fn().mockResolvedValue({ id: 'user-2', username: 'bob' }),
    updateAdminUserRole: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice', role: 'admin' }),
    updateAdminUserStatus: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice', status: 'disabled' }),
    resetAdminUserPassword: vi.fn().mockResolvedValue({ id: 'user-1', username: 'alice' }),
    getBillingSummary: vi.fn().mockResolvedValue({ totalPretaxAmount: 12.5 }),
    listBillingUsers: vi.fn().mockResolvedValue({
      items: [{ userId: 'user-1', username: 'alice' }],
      page: 1,
      pageSize: 20,
      total: 1,
    }),
    getBillingUserSummary: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'alice' }),
    listBillingUserGroups: vi.fn().mockResolvedValue({ items: [{ id: 'group-1' }], page: 1, pageSize: 20, total: 1 }),
    listBillingPlatformGroups: vi.fn().mockResolvedValue({ items: [{ id: 'group-2' }], page: 1, pageSize: 20, total: 1 }),
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
  it('filters admin-only image tools using the authenticated role without granting new scopes', async () => {
    const client = createClientStub(); const registry = createToolRegistry(client);
    const names = registry.listTools(['images:read', 'images:write'], 'user').map(tool => tool.name);
    for (const name of ['platform_image_collect', 'platform_image_publish', 'platform_image_unpublish', 'platform_image_tag_create']) expect(names).not.toContain(name);
    expect(names).toContain('platform_image_tag_list'); expect(names).toContain('platform_image_tags_set');
    await expect(registry.callTool('platform_image_tag_create', ['images:write'], { name: 'blocked' }, 'user')).rejects.toThrow('Forbidden tool');
    expect(client.createPlatformImageTag).not.toHaveBeenCalled();
    expect(registry.listTools(['images:write'], 'admin').map(tool => tool.name)).toContain('platform_image_tag_create');
  });

  it('exposes existing tag capabilities with strict schemas and forwards full replacements and confirmations', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    expect(registry.listTools(['images:read']).map(tool => tool.name)).toContain('platform_image_tag_list');
    expect(registry.listTools(['images:read']).map(tool => tool.name)).not.toContain('platform_image_tag_create');
    expect(registry.listTools(['images:write']).map(tool => tool.name)).toContain('platform_image_tags_set');
    await expect(registry.callTool('platform_image_tag_list', ['images:read'], {})).resolves.toMatchObject({ structuredContent: { result: [{ id: 'tag-1', name: 'Web' }] } });
    await registry.callTool('platform_image_tag_create', ['images:write'], { name: ' Service ', idempotencyKey: 'create-tag', confirmationId: 'confirm-tag' });
    expect(client.createPlatformImageTag).toHaveBeenCalledWith('Service', { idempotencyKey: 'create-tag', confirmationId: 'confirm-tag' });
    await registry.callTool('platform_image_tags_set', ['images:write'], { platformImageAssetId: 'img-1', tagIds: [], idempotencyKey: 'clear-tags', confirmationId: 'confirm-clear' });
    expect(client.setPlatformImageTags).toHaveBeenCalledWith('img-1', [], { idempotencyKey: 'clear-tags', confirmationId: 'confirm-clear' });
    const schema = registry.listTools(['images:write']).find(tool => tool.name === 'platform_image_tags_set')!.inputSchema!;
    expect(schema.safeParse({ platformImageAssetId: 'img-1', tagIds: ['tag-1', 'tag-1'] }).success).toBe(false);
    expect(schema.safeParse({ platformImageAssetId: 'img-1' }).success).toBe(false);
    const names = registry.listTools(['images:read', 'images:write']).map(tool => tool.name);
    expect(names).not.toContain('platform_image_tag_delete');
    expect(names).not.toContain('platform_image_tag_rename');
  });

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
      'range_template_return_to_private',
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
    expect(tools.map((tool) => tool.name)).not.toContain('range_template_unpublish');
    expect(tools.find((tool) => tool.name === 'range_template_return_to_private')?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
    expect(tools.find((tool) => tool.name === 'range_template_topology_detect_and_save')?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
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

  it.each([undefined, false, true])('forwards the optional read-only range network diagnostic flag (%s)', async (includeNetworkDiagnostics) => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    const networkDiagnostics = {
      status: 'succeeded', checkedAt: '2026-10-09T00:00:00Z', regionId: 'cn-hangzhou',
      cloudAccountUid: 'mock-account', vpcId: 'vpc-mock', instances: [{ nodeId: 'entry', privateIp: '10.0.40.10' }],
      networkInterfaces: [], natGateways: [], forwardEntries: [], snatEntries: [], routeTables: [], networkAcls: [], securityGroups: [],
    };
    const snapshot = { id: 'range-1', status: 'running', networkDiagnostics, runtimeCredentials: { password: 'mock-hidden' } };
    (client.getRangeInstance as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot);

    const result = await registry.callTool('range_instance_get', ['ranges:read'], {
      rangeInstanceId: 'range-1', ...(includeNetworkDiagnostics === undefined ? {} : { includeNetworkDiagnostics }),
    });

    expect(client.getRangeInstance).toHaveBeenCalledWith('range-1', includeNetworkDiagnostics === undefined
      ? undefined : { includeNetworkDiagnostics });
    expect(result.structuredContent).toEqual({ result: { id: 'range-1', status: 'running', networkDiagnostics } });
    expect(JSON.stringify(result)).not.toContain('mock-hidden');
    expect(snapshot.runtimeCredentials.password).toBe('mock-hidden');
    const tool = registry.listTools(['ranges:read']).find((entry) => entry.name === 'range_instance_get')!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.requiredScopes).toEqual(['ranges:read']);
    expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it('rejects untyped diagnostic flags and caller-supplied cloud targets before forwarding', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    for (const invalid of [
      { includeNetworkDiagnostics: 'true' },
      { includeNetworkDiagnostics: null },
      { includeNetworkDiagnostics: true, vpcId: 'foreign-vpc' },
      { includeNetworkDiagnostics: true, instanceId: 'foreign-ecs' },
      { includeNetworkDiagnostics: true, regionId: 'foreign-region' },
    ]) {
      await expect(registry.callTool('range_instance_get', ['ranges:read'], { rangeInstanceId: 'range-1', ...invalid }))
        .rejects.toThrow('Invalid input for range_instance_get');
    }
    await expect(registry.callTool('range_instance_get', [], { rangeInstanceId: 'range-1', includeNetworkDiagnostics: true }))
      .rejects.toThrow('Forbidden tool: range_instance_get');
    expect(client.getRangeInstance).not.toHaveBeenCalled();
  });

  it('publishes every front-end range-instance operation as a complete MCP tool', () => {
    const registry = createToolRegistry(createClientStub());
    const tools = registry.listTools([
      'ranges:read',
      'ranges:create',
      'ranges:write',
      'ranges:control',
      'ranges:destroy',
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
      draftRevision: 7,
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
        draftTopologySpec: expect.objectContaining({
          publicEntry: expect.objectContaining({ hostKey: 'ecs-nginx' }),
        }),
        draftScenarioTemplateSpec: expect.objectContaining({
          metadata: expect.objectContaining({ slug: 'web-dmz' }),
          topology: expect.objectContaining({
            vpcCidr: '10.0.0.0/16',
            secondaryVpcCidrs: ['172.16.0.0/16', '192.168.0.0/16'],
          }),
        }),
        draftCompiledProvisionSpec: expect.any(Object),
        expectedDraftRevision: 7,
      }),
      { idempotencyKey: undefined, confirmationId: undefined },
    );
  });

  it('applies only the exact previewed saved revision without implicitly saving a graph', async () => {
    const client = createClientStub(); const registry = createToolRegistry(client);
    await registry.callTool('range_instance_topology_apply', ['ranges:write', 'ranges:control'], { rangeInstanceId: 'range-1', expectedDraftRevision: 8, previewToken: 'preview-8' });
    expect(client.applyRangeInstanceDraft).toHaveBeenCalledWith('range-1', 8, 'preview-8', { idempotencyKey: undefined, confirmationId: undefined });
    expect(client.saveRangeInstanceDraft).not.toHaveBeenCalled();
  });

  it.each([
    ['range_instance_sync_template', ['ranges:write', 'templates:write'], 'syncRangeInstanceTemplate'],
  ] as const)('replays %s confirmation without saving a new draft revision', async (toolName, scopes, method) => {
    const client = createClientStub();
    let instance: Record<string, unknown> = {
      id: 'range-1', name: 'Web DMZ', draftRevision: 7, sourceTemplateRevision: 11,
    };
    (client.getRangeInstance as ReturnType<typeof vi.fn>).mockImplementation(async () => instance);
    (client.saveRangeInstanceDraft as ReturnType<typeof vi.fn>).mockImplementation(async (_id, payload) => {
      instance = JSON.parse(JSON.stringify({ ...instance, ...payload, draftRevision: Number(instance.draftRevision) + 1 }));
      return instance;
    });
    let confirmedRevision: number | undefined;
    (client[method] as ReturnType<typeof vi.fn>).mockImplementation(async (_id, revision, ...rest) => {
      const metadata = rest.at(-1) as { confirmationId?: string };
      if (!metadata.confirmationId) {
        confirmedRevision = revision;
        throw new PlatformApiError(409, 'confirmation required', {
          code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirm-1', idempotencyKey: 'idem-1',
        });
      }
      if (revision !== confirmedRevision) {
        throw new PlatformApiError(409, 'Operation confirmation does not match this request', null);
      }
      return { id: 'range-1', jobId: 'job-1' };
    });
    const registry = createToolRegistry(client);
    const args = { rangeInstanceId: 'range-1', topologyGraph: authoringGraph };

    await expect(registry.callTool(toolName, [...scopes], args)).resolves.toMatchObject({ isError: true });
    await expect(registry.callTool(toolName, [...scopes], {
      ...args, confirmationId: 'confirm-1', idempotencyKey: 'idem-1',
    })).resolves.toMatchObject({ structuredContent: { result: { jobId: 'job-1' } } });
    expect(client.saveRangeInstanceDraft).toHaveBeenCalledTimes(1);
    expect(instance.draftRevision).toBe(8);

    const changedGraph = structuredClone(authoringGraph);
    changedGraph.nodes[0]!.label = 'Changed VPC';
    await expect(registry.callTool(toolName, [...scopes], {
      ...args, topologyGraph: changedGraph, confirmationId: 'confirm-1', idempotencyKey: 'idem-1',
    })).rejects.toThrow('确认请求的拓扑与已保存草稿不一致');
    expect(client.saveRangeInstanceDraft).toHaveBeenCalledTimes(1);
    expect(client[method]).toHaveBeenCalledTimes(2);
  });

  it('derives Tencent creation metadata from the verified fixed workspace for an ordinary template author', async () => {
    const client = createClientStub();
    (client.getCurrentCloudWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'tencent-workspace', provider: 'tencent_cloud', accountUid: '100001', isReadOnly: false,
      activeCloudAccountContextId: 'tencent-context', contexts: [{ id: 'tencent-context', provider: 'tencent_cloud', accountUid: '100001', status: 'ready' }], capabilities: { provisioning: true } });
    const registry = createToolRegistry(client);
    const graph = structuredClone(authoringGraph);
    const host = graph.nodes.find(node => node.kind === 'ecs')!;
    if (host.kind === 'ecs') { host.cpu = 2; host.memory = 2; }
    await registry.callTool('range_template_create', ['templates:write'], { name: '腾讯靶场', topologyGraph: graph }, 'user');
    const payload = (client.createRangeTemplate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(payload.scenarioTemplateSpec.runtimePreferences.instanceTypePolicies)).not.toContain('ecs.');
    expect(client.getCurrentCloudWorkspace).toHaveBeenCalledOnce();
    expect(client.fetchCloudConfig).not.toHaveBeenCalled();
    expect(client.createRangeTemplate).toHaveBeenCalledWith(expect.objectContaining({
      scenarioTemplateSpec: expect.objectContaining({ metadata: expect.objectContaining({ cloudProvider: 'tencent_cloud' }) }),
      compiledProvisionSpec: expect.objectContaining({ identity: expect.objectContaining({ cloudProvider: 'tencent_cloud' }) }),
      compiledSpec: expect.objectContaining({ resources: expect.arrayContaining([expect.objectContaining({ provider: 'tencent_cloud' })]) }),
    }), expect.anything());
  });

  it('preserves Tencent metadata when compiling an existing instance draft', async () => {
    const client = createClientStub();
    (client.getRangeInstance as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'tencent-range', name: 'Tencent range', cloudProvider: 'tencent_cloud', draftRevision: 1,
      draftScenarioTemplateSpec: { metadata: { cloudProvider: 'tencent_cloud' } } });
    await createToolRegistry(client).callTool('range_instance_topology_save', ['ranges:write'], { rangeInstanceId: 'tencent-range', topologyGraph: authoringGraph });
    expect(client.saveRangeInstanceDraft).toHaveBeenCalledWith('tencent-range', expect.objectContaining({
      draftScenarioTemplateSpec: expect.objectContaining({ metadata: expect.objectContaining({ cloudProvider: 'tencent_cloud' }) }),
      draftCompiledProvisionSpec: expect.objectContaining({ identity: expect.objectContaining({ cloudProvider: 'tencent_cloud' }) }),
    }), expect.anything());
  });

  it.each([null, { isReadOnly: true }, { accountUid: null }, { activeCloudAccountContextId: null }, { contexts: [] },
    { contexts: [{ id: 'fixture-context', provider: 'tencent_cloud', accountUid: '100001', status: 'ready' }] },
    { contexts: [{ id: 'fixture-context', provider: 'alibaba_cloud', accountUid: 'different', status: 'ready' }] },
    { contexts: [{ id: 'fixture-context', provider: 'alibaba_cloud', accountUid: '100001', status: 'ready', cloudWorkspaceId: 'foreign-workspace' }] },
    { capabilities: { provisioning: false } }])('refuses unverified creation workspace %j before a template write', async overrides => {
    const client = createClientStub();
    const current = await client.getCurrentCloudWorkspace();
    (client.getCurrentCloudWorkspace as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(overrides === null ? null : { ...current, ...overrides });
    await expect(createToolRegistry(client).callTool('range_template_create', ['templates:write'], { name: 'blocked', topologyGraph: authoringGraph })).rejects.toThrow('已验证');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
    expect(client.fetchCloudConfig).not.toHaveBeenCalled();
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
        scenarioTemplateSpec: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'Web DMZ' }),
          topology: expect.objectContaining({
            vpcCidr: '10.0.0.0/16',
            secondaryVpcCidrs: ['172.16.0.0/16', '192.168.0.0/16'],
          }),
        }),
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

    const payload = (client.createRangeTemplate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      topologyGraph: ScenarioGraphDraft;
      topologySpec: { hosts: Array<{ key: string; exposePublic: boolean }> };
      scenarioTemplateSpec: { hosts: Array<{ key: string; exposePublic: boolean }> };
      compiledProvisionSpec: { hosts: Array<{ key: string; exposePublic: boolean }> };
      compiledSpec: { resources: Array<{ id: string; config: { exposePublic?: boolean } }> };
    };
    expect(payload.topologyGraph.nodes.find((node) => node.id === 'ecs-nginx')).toMatchObject({
      exposePublic: false,
      role: 'web',
    });
    expect(payload.topologySpec.hosts).toEqual([expect.objectContaining({ key: 'ecs-nginx', exposePublic: true })]);
    expect(payload.scenarioTemplateSpec.hosts).toEqual([expect.objectContaining({ key: 'ecs-nginx', exposePublic: true })]);
    expect(payload.compiledProvisionSpec.hosts).toEqual([expect.objectContaining({ key: 'ecs-nginx', exposePublic: true })]);
    expect(payload.compiledSpec.resources.find((resource) => resource.id === 'ecs-nginx')?.config.exposePublic).toBe(true);
  });

  it('creates a template with the API contract instead of caller-supplied server metadata', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);

    await registry.callTool('range_template_create', ['templates:write'], {
      name: 'Web DMZ',
      description: 'Public web entry template',
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

    const payload = (client.createRangeTemplate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      topologySpec: { hosts: Array<{ key: string; exposePublic: boolean }> };
      scenarioTemplateSpec: { hosts: Array<{ key: string; exposePublic: boolean }> };
      compiledProvisionSpec: { hosts: Array<{ key: string; exposePublic: boolean }> };
      compiledSpec: { resources: Array<{ id: string; config: { exposePublic?: boolean } }> };
    };
    const expectedExposure = [
      { key: 'ecs-nginx', exposePublic: true },
      { key: 'ecs-office', exposePublic: false },
      { key: 'ecs-server', exposePublic: false },
    ];
    const expectedExposureMatchers = expectedExposure.map((host) => expect.objectContaining(host));
    expect(payload.topologySpec.hosts).toEqual(expect.arrayContaining(expectedExposureMatchers));
    expect(payload.scenarioTemplateSpec.hosts).toEqual(expect.arrayContaining(expectedExposureMatchers));
    expect(payload.compiledProvisionSpec.hosts).toEqual(expect.arrayContaining(expectedExposureMatchers));
    for (const expectedHost of expectedExposure) {
      expect(payload.compiledSpec.resources.find((resource) => resource.id === expectedHost.key)?.config.exposePublic)
        .toBe(expectedHost.exposePublic);
    }
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

  it('rejects caller-supplied VPC CIDRs and a switch outside the fixed VPC networks', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    const create = registry.listTools(['templates:write']).find((tool) => tool.name === 'range_template_create');
    const invalidNetworkGraph = structuredClone(authoringGraph);
    const switchNode = invalidNetworkGraph.nodes.find((node) => node.id === 'switch-dmz');

    if (switchNode?.kind !== 'switch') {
      throw new Error('Expected a switch node');
    }

    switchNode.cidr = '10.10.20.0/24';

    expect(create?.inputSchema.safeParse({
      name: '不得覆盖平台 VPC',
      primaryVpcCidr: '10.10.0.0/16',
      topologyGraph: authoringGraph,
    }).success).toBe(false);

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: '无效交换机网段',
        topologyGraph: invalidNetworkGraph,
      }),
    ).rejects.toThrow('交换机 CIDR 不在主 VPC 或附加 VPC 网段内：switch-dmz');
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

  it('requires explicit switch NAT, derives public entry from DNAT, and exposes DNAT mappings in the create schema', () => {
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

    const graphWithoutLegacyPublicFlag = structuredClone(authoringGraph);
    const host = graphWithoutLegacyPublicFlag.nodes.find((node) => node.id === 'ecs-nginx');
    if (host?.kind !== 'ecs') {
      throw new Error('Expected an ECS node');
    }
    delete (host as Partial<typeof host>).exposePublic;

    const parsedGraphWithoutLegacyPublicFlag = create?.inputSchema?.safeParse({
      name: '不要求旧公网标记',
      topologyGraph: graphWithoutLegacyPublicFlag,
    });
    expect(parsedGraphWithoutLegacyPublicFlag?.success).toBe(true);
    if (!parsedGraphWithoutLegacyPublicFlag?.success) {
      throw new Error('Expected topology graph without exposePublic to parse');
    }
    expect(
      (parsedGraphWithoutLegacyPublicFlag.data as { topologyGraph: ScenarioGraphDraft })
        .topologyGraph.nodes.find((node) => node.id === 'ecs-nginx'),
    ).toMatchObject({ exposePublic: false });
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

  it('accepts a pure private topology without DNAT despite legacy public flags', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    const invalidGraph = structuredClone(authoringGraph);
    const switchNode = invalidGraph.nodes.find((node) => node.id === 'switch-dmz');

    if (switchNode?.kind !== 'switch') {
      throw new Error('Expected a switch node');
    }

    switchNode.nat = { snatEnabled: false, dnatMappings: [] };
    await registry.callTool('range_template_create', ['templates:write'], { name: '纯内网', topologyGraph: invalidGraph });
    const created = vi.mocked(client.createRangeTemplate).mock.calls[0]![0];
    expect(created.compiledProvisionSpec).toMatchObject({ natGateways: [], eips: [], dnatEntries: [] });
    expect((created.topologyGraph as ScenarioGraphDraft).nodes.filter((node) => node.kind === 'ecs').every((node) => !node.exposePublic)).toBe(true);
  });

  it('accepts multiple host DNAT mappings sharing one public entry', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    const invalidGraph = structuredClone(authoringGraph);
    addEcsNode(invalidGraph, {
      id: 'ecs-api',
      label: 'API',
      zoneKey: 'dmz',
      switchId: 'switch-dmz',
      privateIp: '10.0.0.11',
    });
    const switchNode = invalidGraph.nodes.find((node) => node.id === 'switch-dmz');
    if (switchNode?.kind !== 'switch' || !switchNode.nat) {
      throw new Error('Expected a switch node');
    }
    switchNode.nat.dnatMappings.push({
      key: 'api-8080',
      targetHostId: 'ecs-api',
      externalPort: 8080,
      internalPort: 8080,
      protocol: 'tcp',
    });

    await registry.callTool('range_template_create', ['templates:write'], { name: '多个 DNAT 目标', topologyGraph: invalidGraph });
    const created = vi.mocked(client.createRangeTemplate).mock.calls[0]![0];
    expect(created.compiledProvisionSpec.dnatEntries).toEqual(expect.arrayContaining([expect.objectContaining({ hostKey: 'ecs-nginx' }), expect.objectContaining({ hostKey: 'ecs-api' })]));
  });

  it('rejects a DNAT mapping whose target ECS does not exist', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    const invalidGraph = structuredClone(authoringGraph);
    const switchNode = invalidGraph.nodes.find((node) => node.id === 'switch-dmz');
    if (switchNode?.kind !== 'switch' || !switchNode.nat) {
      throw new Error('Expected a switch node');
    }
    switchNode.nat.dnatMappings[0]!.targetHostId = 'ecs-missing';

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: 'DNAT 目标不存在',
        topologyGraph: invalidGraph,
      }),
    ).rejects.toThrow('DNAT 引用了不存在的 ECS：ecs-missing');
    expect(client.createRangeTemplate).not.toHaveBeenCalled();
  });

  it('rejects a DNAT mapping whose target ECS is not connected to its switch', async () => {
    const client = createClientStub();
    const registry = createToolRegistry(client);
    const invalidGraph = structuredClone(authoringGraph);
    invalidGraph.nodes.push({
      id: 'switch-internal',
      kind: 'switch',
      label: '内部交换机',
      zoneKey: 'internal',
      cidr: '10.0.1.0/24',
      purpose: 'internal',
      nat: { snatEnabled: false, dnatMappings: [] },
      aclRules: [],
    });
    invalidGraph.edges.push({
      id: 'router-to-switch-internal',
      fromNodeId: 'router-main',
      toNodeId: 'switch-internal',
      relationType: 'manual',
    });
    addEcsNode(invalidGraph, {
      id: 'ecs-internal',
      label: '内部主机',
      zoneKey: 'internal',
      switchId: 'switch-internal',
      privateIp: '10.0.1.10',
    });
    const switchNode = invalidGraph.nodes.find((node) => node.id === 'switch-dmz');
    if (switchNode?.kind !== 'switch' || !switchNode.nat) {
      throw new Error('Expected a switch node');
    }
    switchNode.nat.dnatMappings[0]!.targetHostId = 'ecs-internal';

    await expect(
      registry.callTool('range_template_create', ['templates:write'], {
        name: 'DNAT 目标未连交换机',
        topologyGraph: invalidGraph,
      }),
    ).rejects.toThrow('DNAT 目标 ECS 未连接到交换机：nginx-80');
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

  it('accepts a DNAT target regardless of legacy public entry flags', async () => {
    const client = createClientStub();
    const invalidGraph = structuredClone(authoringGraph);
    const host = invalidGraph.nodes.find((node) => node.id === 'ecs-nginx')!;

    if (host.kind !== 'ecs') {
      throw new Error('Expected an ECS node');
    }

    host.role = 'host';
    host.exposePublic = false;
    const registry = createToolRegistry(client);

    await registry.callTool('range_template_create', ['templates:write'], {
      name: 'Web DMZ',
      topologyGraph: invalidGraph,
    });
    expect(client.createRangeTemplate).toHaveBeenCalledOnce();
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
      'images:read', 'images:write', 'ranges:read', 'ranges:create', 'ranges:write', 'ranges:control', 'ranges:destroy',
      'instances:read', 'instances:create', 'instances:destroy', 'instances:control', 'instances:credentials:read',
      'jobs:read', 'users:read', 'users:write', 'billing:read', 'billing:sync', 'settings:read', 'settings:write',
    ];

    const tools = registry.listTools(scopes);

    expect(tools).toHaveLength(89);
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
    (client.getRangeInstance as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'range-2',
      draftRevision: 7,
      sourceTemplateRevision: 11,
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
    (client.saveRangeInstanceDraft as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'range-2',
      draftRevision: 8,
      sourceTemplateRevision: 11,
    });
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
    expect(client.syncRangeInstanceTemplate).toHaveBeenCalledWith(
      'range-2',
      8,
      11,
      { idempotencyKey: undefined, confirmationId: undefined },
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
