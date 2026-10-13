import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { compileTemplateTopology } from '@aliyun-cyber-range/scenario-runtime/compiled';
import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { PackedImagesService } from '../src/admin/packed-images.service';
import { ProvisionJobsService } from '../src/admin/provision-jobs.service';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';
import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import { CidrPoolService } from '../src/provisioning/cidr-pool.service';
import { rangeTemplatePayload } from './support/range-api-fixture';
import type { ProvisionJobTopologySnapshot } from '../src/admin/admin.repository';

import { desiredResources } from '../src/provisioning/range-update-plan-safety';

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeWithDatabase('PostgreSQL multi-user range lifecycle isolation', () => {
  let prisma: PrismaService;
  let repository: PrismaAdminRepository;
  let root: string;
  let config: any;
  let alice: any;
  let bob: any;
  let asset: any;
  let service: RangeInstancesService;
  let templates: RangeTemplatesService;
  let provisioner: OpenTofuRangeProvisioner;
  let workers: ProvisioningWorkerService[];
  let apply: jest.Mock;
  let cloudCalls: Array<{ action: string; instanceId: string | null }>;
  // Real Alibaba resource ids are a lowercase prefix plus alphanumerics. The
  // platform now verifies exact physical identities and reconciles the OpenTofu
  // plan and state with its persisted inventory, so the fixture models them.
  const rangePrefixes: Record<string, string> = {
    alicloud_instance: 'i', alicloud_vpc: 'vpc', alicloud_vswitch: 'vsw', alicloud_security_group: 'sg',
    alicloud_network_interface: 'eni', alicloud_network_interface_attachment: 'eniattach', alicloud_security_group_rule: 'sgr',
    alicloud_network_acl: 'nacl', alicloud_nat_gateway: 'ngw', alicloud_eip_address: 'eip', alicloud_eip_association: 'eipassoc',
    alicloud_vpc_ipv4_cidr_block: 'vpcblock', alicloud_snat_entry: 'snat', alicloud_forward_entry: 'fwd',
  };
  const resourceKeyOf = (address: string) => {
    const match = address.match(/\[("(?:[^"\\]|\\.)*")\]$/);
    return match ? String(JSON.parse(match[1])) : null;
  };
  const resourceIdOf = (workspaceId: string, address: string, type: string) =>
    `${rangePrefixes[type] ?? 'res'}-${workspaceId}${(resourceKeyOf(address) ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const workspaceResources = (workspaceId: string, vars: any) => [...desiredResources(vars, false).entries()].map(([address, definition]) => ({
    address, type: definition.type, kind: definition.kind, id: resourceIdOf(workspaceId, address, definition.type),
  }));
  const taggableTypes = new Set(['alicloud_vpc','alicloud_vswitch','alicloud_network_acl','alicloud_security_group',
    'alicloud_instance','alicloud_network_interface','alicloud_nat_gateway','alicloud_eip_address']);
  const resourceAttributes = (vars: any, resource: { address: string; type: string; id: string }) =>
    taggableTypes.has(resource.type)
      ? { id: resource.id, ...(resource.type === 'alicloud_instance' ? { availability_zone: vars.zone_id } : {}), tags: { ...vars.tags } }
      : { id: resource.id };
  const writeWorkspaceState = async (workspaceDir: string, vars: any) => {
    const workspaceId = path.basename(workspaceDir);
    const grouped = new Map<string, { module: string; type: string; name: string; mode: string; instances: any[] }>();
    for (const resource of workspaceResources(workspaceId, vars)) {
      const match = resource.address.match(/^(module\.[a-z0-9_]+)\.([a-z0-9_]+)\.([A-Za-z0-9_]+)(?:\[("(?:[^"\\]|\\.)*")\])?$/);
      if (!match) throw new Error(`Unsupported fixture resource address ${resource.address}`);
      const [, moduleName, type, name, indexKey] = match;
      const groupKey = `${moduleName}.${type}.${name}`;
      const group = grouped.get(groupKey) ?? { module: moduleName, type, name, mode: 'managed', instances: [] as any[] };
      group.instances.push({ ...(indexKey === undefined ? {} : { index_key: JSON.parse(indexKey) }), attributes: resourceAttributes(vars, resource) });
      grouped.set(groupKey, group);
    }
    await fs.writeFile(path.join(workspaceDir, 'terraform.tfstate'), JSON.stringify({ version: 4, lineage: 'test-lineage', serial: 1, resources: [...grouped.values()] }));
  };
  const readFixtureState = async (workspaceDir: string) => {
    try { return JSON.parse(await fs.readFile(path.join(workspaceDir, 'terraform.tfstate'), 'utf8')); } catch { return null; }
  };
  const fixtureStateAttributes = (state: any) => new Map<string, Record<string, any>>((state?.resources ?? []).flatMap((resource: any) => resource.instances.map((instance: any) => [
    `${resource.module ? `${resource.module}.` : ''}${resource.type}.${resource.name}${instance.index_key === undefined ? '' : `[${JSON.stringify(instance.index_key)}]`}`,
    instance.attributes,
  ])));
  const metadata = {
    name: 'Two-node concurrency fixture', slug: 'two-node-concurrency', version: 'v1',
    cloudProvider: 'alibaba_cloud' as const, iacType: 'opentofu' as const,
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range', primaryVpcCidr: '10.0.0.0/16',
    description: 'Range owner isolation fixture', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h',
  };

  beforeAll(async () => { prisma = new PrismaService(); await prisma.$connect(); repository = new PrismaAdminRepository(prisma); });
  afterAll(async () => { await prisma.$disconnect(); });

  beforeEach(async () => {
    const suffix = randomUUID();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'range-owner-isolation-'));
    alice = await repository.createPlatformUser({ id: `alice-${suffix}`, username: `alice-${suffix}`, passwordHash: 'unused-test-hash', role: 'user' });
    bob = await repository.createPlatformUser({ id: `bob-${suffix}`, username: `bob-${suffix}`, passwordHash: 'unused-test-hash', role: 'user' });
    await repository.upsertImageSnapshots({ provider: 'alibaba_cloud', accountUid: 'test-account', regionId: 'cn-hangzhou', scope: 'public',
      snapshots: [{ imageId: `m-fixture${suffix.replaceAll('-', '')}`, sourceImageName: 'Fixture Linux', osType: 'linux', status: 'Available', isAvailable: true, lastSyncedAt: new Date() }],
    });
    const [snapshot] = await repository.listImageSnapshots({ imageId: `m-fixture${suffix.replaceAll('-', '')}` });
    asset = await repository.collectPlatformImageAsset({ snapshotId: snapshot!.id, displayName: 'Fixture Linux', ownerUserId: alice.id, visibility: 'platform' });
    config = { getSnapshot: async () => ({ accessKeyId: 'test-ak', accessKeySecret: 'test-sk', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h' }),
      getExecutionAccountContext: async () => ({ provider: 'alibaba_cloud', accessKeyId: 'test-ak', accessKeySecret: 'test-sk', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accountUid: 'test-account', accountUidResolved: true, cloudAccountContextId: 'fixture-context' }),
    };
    config.getAccountContext = config.getExecutionAccountContext;
    config.getAccountContextById = config.getExecutionAccountContext;
    cloudCalls = [];
    const cloudTags = new Map<string, Record<string, string>>();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const query = new URL(String(url)).searchParams;
      cloudCalls.push({ action: query.get('Action')!, instanceId: query.get('InstanceId') });
      if (query.get('Action') === 'DescribeVpcAttribute') {
        // This fixture models cloud absence after its mocked destroy. A get API
        // reports a missing exact ID via a receipt, not an empty list payload.
        return new Response(JSON.stringify({ RequestId: 'fixture-vpc-absence', Code: 'InvalidVpcId.NotFound' }), { status: 404 });
      }
      if (query.get('Action') === 'DescribeInstances') {
        const ids = JSON.parse(query.get('InstanceIds') ?? '[]') as string[];
        return { ok: true, json: async () => ({ RequestId: 'fixture-request', PageSize: 100, PageNumber: 1, TotalCount: ids.filter(id => cloudTags.has(id)).length, Instances: { Instance: ids.flatMap(id => cloudTags.has(id) ? [{
          InstanceId: id, Status: 'Running', Tags: { Tag: Object.entries(cloudTags.get(id)!).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) },
        }] : []) } }) } as Response;
      }
      if (query.get('Action') === 'DescribeDisks') {
        const requested = query.has('DiskIds') ? JSON.parse(query.get('DiskIds')!) as string[] : null;
        const disks = [...cloudTags].flatMap(([instanceId, tags]) => ['system', 'data'].map(type => ({
          DiskId: `d-${instanceId.slice(2)}-${type}`, InstanceId: instanceId, Type: type, DeleteWithInstance: true,
          Tags: { Tag: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) },
        }))).filter(disk => requested ? requested.includes(disk.DiskId) : disk.InstanceId === query.get('InstanceId'));
        return { ok: true, json: async () => ({ RequestId: 'fixture-disks', PageSize: 100, PageNumber: 1,
          TotalCount: disks.length, Disks: { Disk: disks } }) } as Response;
      }
      return { ok: true, json: async () => ({ RequestId: 'fixture-request', PageSize: Number(query.get('PageSize') ?? 100), PageNumber: 1, TotalCount: 0, Disks: { Disk: [] }, Instances: { Instance: [] }, Vpcs: { Vpc: [] }, VSwitches: { VSwitch: [] }, NatGateways: { NatGateway: [] }, EipAddresses: { EipAddress: [] }, NetworkInterfaceSets: { NetworkInterfaceSet: [] }, SecurityGroups: { SecurityGroup: [] }, NetworkAcls: { NetworkAcl: [] }, SnatTableEntries: { SnatTableEntry: [] }, ForwardTableEntries: { ForwardTableEntry: [] }, VncUrl: 'mock-vnc' }) } as Response;
    });
    apply = jest.fn(async (options: { workspaceDir: string }) => {
      const vars = JSON.parse(await fs.readFile(path.join(options.workspaceDir, 'range.auto.tfvars.json'), 'utf8'));
      await writeWorkspaceState(options.workspaceDir, vars);
      return { stdout: 'apply complete', stderr: '' };
    });
    const runner: any = {
      init: jest.fn().mockResolvedValue({ stdout: 'init', stderr: '' }), validate: jest.fn().mockResolvedValue({ stdout: 'validate', stderr: '' }),
      showPlan: jest.fn(async (options: { workspaceDir: string }) => {
        const vars = JSON.parse(await fs.readFile(path.join(options.workspaceDir, 'range.auto.tfvars.json'), 'utf8'));
        const resources = workspaceResources(path.basename(options.workspaceDir), vars);
        const planned = new Set(resources.map(resource => resource.address));
        const actual = fixtureStateAttributes(await readFixtureState(options.workspaceDir));
        const taggable = taggableTypes;
        return { format_version: '1.2', terraform_version: '1.13.1', errored: false, complete: true,
          planned_values: { root_module: { child_modules: [{ address: 'module.range', resources: resources.map(resource => ({ address: resource.address, type: resource.type, mode: 'managed' })) }] } },
          resource_changes: [
            ...resources.map(resource => {
              const existing = actual.get(resource.address);
              const creating = !existing && resource.kind === 'host';
              return { address: resource.address, type: resource.type, mode: 'managed', change: {
                actions: existing ? ['no-op'] : creating ? ['create'] : ['no-op'],
                before: existing ? { ...existing } : null,
                after: { ...resourceAttributes(vars, resource), ...(taggable.has(resource.type) ? { tags: { ...vars.tags } } : {}) },
                after_unknown: creating ? { id: true } : {} } };
            }),
            ...[...actual.keys()].filter(address => !planned.has(address)).map(address => ({ address, type: String(address.split('.')[2] ?? 'res'), mode: 'managed',
              change: { actions: ['delete'], before: { ...actual.get(address) }, after: null } })),
          ] };
      }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan', stderr: '' }), apply,
      output: jest.fn(async (options: { workspaceDir: string }) => {
        const id = path.basename(options.workspaceDir);
        const vars = JSON.parse(await fs.readFile(path.join(options.workspaceDir, 'range.auto.tfvars.json'), 'utf8'));
        const resources = workspaceResources(id, vars);
        for (const resource of resources.filter(resource => resource.type === 'alicloud_instance')) cloudTags.set(resource.id, { ...vars.tags, AccessKeySecret: 'ignored-secret-tag' });
        const byType = (type: string) => Object.fromEntries(resources.filter(resource => resource.type === type)
          .map(resource => [resourceKeyOf(resource.address) ?? resource.address, resource.id]));
        return { public_entry: { value: { host_role: 'entry', public_ip: `mock-${id}`, private_ip: vars.hosts[0].private_ip, ssh: null } },
          resource_summary: { value: {
            vpc_id: resources.find(resource => resource.type === 'alicloud_vpc')?.id,
            subnet_ids: byType('alicloud_vswitch'), host_ids: byType('alicloud_instance'),
            security_group_ids: byType('alicloud_security_group'), network_acl_ids: byType('alicloud_network_acl'),
            secondary_network_interface_ids: byType('alicloud_network_interface'),
            nat_gateway_ids: byType('alicloud_nat_gateway'), eip_allocation_ids: byType('alicloud_eip_address'),
            snat_entry_ids: byType('alicloud_snat_entry'), dnat_entry_ids: byType('alicloud_forward_entry'),
          } },
        };
      }),
      destroy: jest.fn(async (options: { workspaceDir: string }) => {
        const id = path.basename(options.workspaceDir);
        for (const key of cloudTags.keys()) if (key.startsWith(`i-${id}`)) cloudTags.delete(key);
        await fs.writeFile(path.join(options.workspaceDir, 'terraform.tfstate'), JSON.stringify({ version: 4, lineage: 'test-lineage', serial: 1, resources: [] }));
        return { stdout: 'destroy complete', stderr: '' };
      }),
    };
    provisioner = new OpenTofuRangeProvisioner({ runner, projectRootDir: '/app', workspacesRootDir: root,
      env: { OPENTOFU_INSTANCE_TYPE: 'ecs.mock.large' },
      availableImageIdResolver: async () => asset.imageId,
    });
    workers = [new ProvisioningWorkerService(repository, provisioner, config), new ProvisioningWorkerService(repository, provisioner, config)];
    templates = new RangeTemplatesService(repository, config);
    service = new RangeInstancesService(repository, templates, config, new CidrPoolService(), workers[0]);
  });

  afterEach(async () => { jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

  function graph() {
    const draft: any = rangeTemplatePayload(asset, metadata.name, metadata.primaryVpcCidr).topologyGraph;
    const entry = draft.nodes.find((node: any) => node.kind === 'ecs');
    const dmz = draft.nodes.find((node: any) => node.kind === 'switch');
    dmz.nat.dnatMappings[0].externalPort = 8080; dmz.nat.dnatMappings[0].internalPort = 80;
    const rules = [{ key: 'internal', direction: 'ingress', policy: 'accept', protocol: 'all', portRange: '-1/-1', sourceCidr: '10.0.0.0/16', priority: 10 }];
    entry.cpu = 2; entry.memory = 4; entry.nics[0].securityGroupRulesMode = 'custom'; entry.nics[0].securityGroupRules = [{ key: 'entry-http', direction: 'ingress', policy: 'accept', protocol: 'tcp', portRange: '80/80', sourceCidr: '198.51.100.20/32', priority: 10 }];
    entry.nics.push({ id: 'entry-office', switchId: 'switch-office', privateIp: '10.0.20.10', secondaryIps: [], securityGroupRulesMode: 'custom', securityGroupRules: rules.map(rule => ({ ...rule, key: 'entry-office-internal' })) });
    const backend = JSON.parse(JSON.stringify(entry));
    backend.id = 'office-backend'; backend.label = 'Backend'; backend.role = 'backend'; backend.zoneKey = 'office'; backend.privateIp = '10.0.20.20'; backend.exposePublic = false;
    backend.nics = [{ id: 'backend-office', switchId: 'switch-office', privateIp: backend.privateIp, secondaryIps: [], securityGroupRulesMode: 'custom', securityGroupRules: rules.map(rule => ({ ...rule, key: 'backend-office-internal' })) }];
    draft.nodes.push({ id: 'switch-office', kind: 'switch', label: 'Office', zoneKey: 'office', cidr: '10.0.20.0/24', purpose: 'private',
      aclRules: [
        { key: 'office-in', direction: 'inbound', policy: 'allow', protocol: 'all', portRange: '-1/-1', sourceCidr: '10.0.0.0/16', priority: 10 },
        { key: 'office-out', direction: 'outbound', policy: 'allow', protocol: 'all', portRange: '-1/-1', sourceCidr: '0.0.0.0/0', priority: 10 },
      ], nat: { snatEnabled: true, dnatMappings: [] },
    }, backend);
    draft.edges.push(
      { id: 'router-office', fromNodeId: 'router-main', toNodeId: 'switch-office', relationType: 'manual' },
      { id: 'office-entry', fromNodeId: 'switch-office', toNodeId: entry.id, relationType: 'manual' },
      { id: 'office-backend', fromNodeId: 'switch-office', toNodeId: backend.id, relationType: 'manual' },
    );
    return draft;
  }

  const compile = (draft: any, extra = {}) => JSON.parse(JSON.stringify(compileTemplateTopology(draft, { ...metadata, ...extra })));
  const draftInput = (compiled: any, expectedDraftRevision = 0) => ({ expectedDraftRevision,
    draftTopologyGraph: compiled.topologyGraph, draftTopologySpec: compiled.topologySpec,
    draftScenarioTemplateSpec: compiled.scenarioTemplateSpec, draftCompiledProvisionSpec: compiled.compiledProvisionSpec,
  });

  async function sharedTemplate() {
    const compiled = compile(graph());
    const template = await repository.createRangeTemplate({ ...compiled, ...metadata, slug: `range-${randomUUID()}`, ownerUserId: alice.id });
    await templates.publishToPlatform(template.id, template.revision, alice);
    return template;
  }

  async function launchBoth() {
    const template = await sharedTemplate();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const [a, b] = await Promise.all([
      service.launch({ templateId: template.id, name: 'Alice range', expiresAt }, alice),
      service.launch({ templateId: template.id, name: 'Bob range', expiresAt }, bob),
    ]);
    await Promise.all([workers[0].process(a.lastJobId!), workers[1].process(b.lastJobId!)]);
    return { template, a: (await repository.getRangeInstanceById(a.id))!, b: (await repository.getRangeInstanceById(b.id))! };
  }

  it('keeps concurrent Alice/Bob 2-ECS workspaces, outputs, control and ledger ownership separate', async () => {
    const { a, b } = await launchBoth();
    expect(a.status).toBe('running'); expect(b.status).toBe('running'); expect(a.id).not.toBe(b.id);
    expect(a.resourceSummary).toMatchObject({ creationAttempted: true, executionContext: { cloudAccountContextId: 'fixture-context', cloudAccountUid: 'test-account', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h' } });
    const aVars = JSON.parse(await fs.readFile(path.join(root, a.id, 'range.auto.tfvars.json'), 'utf8'));
    const bVars = JSON.parse(await fs.readFile(path.join(root, b.id, 'range.auto.tfvars.json'), 'utf8'));
    expect(aVars.hosts).toHaveLength(2); expect(bVars.hosts).toHaveLength(2);
    expect(aVars.nat_gateways).toHaveLength(1); expect(aVars.eips).toHaveLength(2);
    expect(aVars.snat_entries).toHaveLength(1); expect(aVars.dnat_entries).toHaveLength(1); expect(aVars.acls).toHaveLength(2);
    expect(aVars.host_network_interfaces.flatMap((item: any) => item.interfaces.filter((nic: any) => nic.device_index > 0))).toHaveLength(1);
    expect(aVars.tags.PlatformUserId).toBe(alice.id); expect(bVars.tags.PlatformUserId).toBe(bob.id);
    expect(aVars.resource_name_prefix).not.toBe(bVars.resource_name_prefix);
    expect(a.resourceSummary!.hostIds!['dmz-entry']).not.toBe(b.resourceSummary!.hostIds!['dmz-entry']);
    expect(Object.keys(a.runtimeCredentials!)).toEqual(expect.arrayContaining(['dmz-entry', 'office-backend']));
    expect(a.runtimeCredentials!['dmz-entry'].password === b.runtimeCredentials!['dmz-entry'].password).toBe(false);
    const describeCount = cloudCalls.filter(call => call.action === 'DescribeInstances').length;
    const actualFacts = await service.getById(a.id, alice);
    expect(cloudCalls.filter(call => call.action === 'DescribeInstances')).toHaveLength(describeCount + 1);
    expect(actualFacts.nodeBillingTags!['dmz-entry']).toMatchObject({ PlatformUserId: alice.id, RangeInstanceId: a.id, PlatformScope: 'user' });
    expect(JSON.stringify(actualFacts.nodeBillingTags).includes('ignored-secret-tag')).toBe(false);
    const aliceRows = await service.list(alice); const bobRows = await service.list(bob);
    expect(aliceRows.map(row => row.id)).toContain(a.id); expect(aliceRows.map(row => row.id)).not.toContain(b.id);
    expect(bobRows.map(row => row.id)).toContain(b.id); expect(bobRows.map(row => row.id)).not.toContain(a.id);
    await expect(service.getById(a.id, bob)).rejects.toMatchObject({ status: 403 });
    await expect(service.getAccessById(a.id, bob)).rejects.toMatchObject({ status: 403 });
    await expect(service.triggerDestroy(a.id, bob)).rejects.toMatchObject({ status: 403 });
    await expect(service.discardDraft(a.id, bob)).rejects.toMatchObject({ status: 403 });
    const nodeActions = new RangeInstanceNodeActionsService(repository, config, {} as PackedImagesService);
    const callsBefore = cloudCalls.length;
    await expect(nodeActions.run(a.id, 'dmz-entry', 'stop', {}, bob)).rejects.toMatchObject({ status: 403 });
    expect(cloudCalls).toHaveLength(callsBefore);
    await nodeActions.run(a.id, 'dmz-entry', 'stop', {}, alice);
    expect(cloudCalls.at(-1)).toEqual({ action: 'StopInstance', instanceId: a.resourceSummary!.hostIds!['dmz-entry'] });
    const jobs = new ProvisionJobsService(repository);
    await expect(jobs.getById(a.lastJobId!, bob)).rejects.toMatchObject({ status: 403 });
    expect(JSON.stringify(await jobs.getById(a.lastJobId!, alice))).not.toContain('"runtimeCredentials"');
    const allLedgers = await repository.listBillingLedgerResources();
    expect(allLedgers.filter(row => row.rangeInstanceId === a.id && row.cloudResourceType === 'disk')).toHaveLength(4);
    expect(allLedgers.filter(row => row.rangeInstanceId === b.id && row.cloudResourceType === 'disk')).toHaveLength(4);
    expect(allLedgers.filter(row => row.rangeInstanceId === a.id).every(row => row.ownerUserId === alice.id)).toBe(true);
    expect(allLedgers.filter(row => row.rangeInstanceId === b.id).every(row => row.ownerUserId === bob.id)).toBe(true);
    const bobState = await fs.readFile(path.join(root, b.id, 'terraform.tfstate'), 'utf8');
    const destroy = await service.triggerDestroy(a.id, alice); await workers[0].process(destroy.id);
    expect((await repository.getRangeInstanceById(a.id))!.status).toBe('destroyed');
    expect((await repository.getRangeInstanceById(b.id))!.status).toBe('running');
    expect(await fs.readFile(path.join(root, b.id, 'terraform.tfstate'), 'utf8')).toBe(bobState);
    const ledgersAfter = await repository.listBillingLedgerResources();
    expect(ledgersAfter.filter(row => row.rangeInstanceId === a.id).every(row => row.releasedAt !== null)).toBe(true);
    expect(ledgersAfter.filter(row => row.rangeInstanceId === b.id).every(row => row.releasedAt === null)).toBe(true);
  });

  it('retains an applied range when a legacy replay no longer matches the frozen definition', async () => {
    const { a } = await launchBoth();
    const statePath = path.join(root, a.id, 'terraform.tfstate');
    const stateBefore = await fs.readFile(statePath, 'utf8');
    const frozenHostId = a.resourceSummary!.hostIds!['office-backend'];
    // A legacy row without frozen definitions can only resolve the current
    // template; that is not proof the deployed range may be replayed.
    await repository.updateRangeInstance(a.id, { status: 'create_failed', runtimeTopologyGraph: null,
      runtimeCompiledProvisionSpec: null, sourceTemplateVersionId: null });
    const retry = await repository.createProvisionJob({ rangeInstanceId: a.id, jobType: 'retry', triggeredBy: alice.id, retryCount: 1 });
    await repository.updateRangeInstance(a.id, { lastJobId: retry.id });
    await workers[0].process(retry.id);

    const after = (await repository.getRangeInstanceById(a.id))!;
    expect((await repository.getProvisionJobById(retry.id))!.status).toBe('failed');
    expect(after.status).toBe('destroy_failed');
    expect(after.errorSummary).toContain('confirmed preview');
    expect(after.errorSummary).toContain('preserved; recovery is required');
    expect(await fs.readFile(statePath, 'utf8')).toBe(stateBefore);
    expect(cloudCalls.some(call => call.action === 'DeleteInstances')).toBe(false);
    expect(after.resourceSummary!.hostIds!['office-backend']).toBe(frozenHostId);
    expect((await repository.listBillingLedgerResources()).filter(row => row.rangeInstanceId === a.id).every(row => row.releasedAt === null)).toBe(true);
  });

  it('preserves an applied range when the apply-intent write fails before any apply', async () => {
    const { a } = await launchBoth();
    const statePath = path.join(root, a.id, 'terraform.tfstate');
    const stateBefore = await fs.readFile(statePath, 'utf8');
    await repository.updateRangeInstance(a.id, { status: 'create_failed' });
    const retry = await repository.createProvisionJob({ rangeInstanceId: a.id, jobType: 'retry', triggeredBy: alice.id, retryCount: 1 });
    await repository.updateRangeInstance(a.id, { lastJobId: retry.id });
    const original = repository.updateRangeInstanceForProvisionJob.bind(repository);
    const spy = jest.spyOn(repository, 'updateRangeInstanceForProvisionJob').mockImplementation(async (jobId, startedAt, data) => {
      if ((data as { resourceSummary?: { creationAttempted?: boolean } }).resourceSummary?.creationAttempted) {
        throw new Error('simulated apply-intent write failure');
      }
      return original(jobId, startedAt, data);
    });
    try { await workers[0].process(retry.id); } finally { spy.mockRestore(); }

    const after = (await repository.getRangeInstanceById(a.id))!;
    expect(after.status).toBe('destroy_failed');
    expect(after.errorSummary).toContain('preserved; recovery is required');
    expect(await fs.readFile(statePath, 'utf8')).toBe(stateBefore);
    expect(cloudCalls.some(call => call.action === 'DeleteInstances')).toBe(false);
    expect((await repository.listBillingLedgerResources()).filter(row => row.rangeInstanceId === a.id).every(row => row.releasedAt === null)).toBe(true);
  });

  it('allows only one concurrent same-instance apply/destroy and defers expiration while update is active', async () => {
    const { a } = await launchBoth();
    const saved = await service.saveDraft(a.id, draftInput(compile(graph())), alice);
    const results = await Promise.allSettled([
      service.applyDraft(a.id, { expectedDraftRevision: saved.draftRevision!, previewToken: (await service.previewDraft(a.id, { expectedDraftRevision: saved.draftRevision! }, alice)).previewToken }, alice), service.triggerDestroy(a.id, alice),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await repository.listProvisionJobs()).filter(job => job.rangeInstanceId === a.id && ['pending', 'running'].includes(job.status))).toHaveLength(1);
    const active = (await repository.listProvisionJobs()).find(job => job.rangeInstanceId === a.id && job.status === 'pending')!;
    await workers[0].process(active.id);
    if (active.jobType === 'destroy') return;
    const next = await service.saveDraft(a.id, draftInput(compile(graph()), (await repository.getRangeInstanceById(a.id))!.draftRevision!), alice);
    const update = await service.applyDraft(a.id, { expectedDraftRevision: next.draftRevision!, previewToken: (await service.previewDraft(a.id, { expectedDraftRevision: next.draftRevision! }, alice)).previewToken }, alice);
    await repository.updateRangeInstance(a.id, { expiresAt: new Date(Date.now() - 1000) });
    await workers[0].processExpiredInstances(new Date());
    expect((await repository.listProvisionJobs()).filter(job => job.rangeInstanceId === a.id && ['pending', 'running'].includes(job.status))).toHaveLength(1);
    await workers[0].process(update.id);
    await workers[0].processExpiredInstances(new Date());
    expect((await repository.getRangeInstanceById(a.id))!.status).toBe('pending_destroy');
  });

  it('freezes the graph, image and private IP accepted at launch before a later template edit', async () => {
    const template = await sharedTemplate();
    const launched = await service.launch({ templateId: template.id, name: 'Frozen Alice', expiresAt: new Date(Date.now() + 3600000).toISOString() }, alice);
    const edited = graph(); const entry = edited.nodes.find((node: any) => node.id === 'dmz-entry');
    entry.privateIp = '10.0.10.40'; entry.nics[0].privateIp = entry.privateIp;
    await templates.validateAndSave(template.id, { ...compile(edited), expectedRevision: (await repository.getRangeTemplateById(template.id))!.revision }, alice);
    await workers[0].process(launched.lastJobId!);
    const vars = JSON.parse(await fs.readFile(path.join(root, launched.id, 'range.auto.tfvars.json'), 'utf8'));
    expect(vars.hosts.find((host: any) => host.key === 'dmz-entry').private_ip).toBe('10.0.10.10');
    expect((await repository.getRangeInstanceById(launched.id))!.runtimeTopologyGraph!.nodes).toEqual((launched.runtimeTopologyGraph as any).nodes);
  });

  it('atomically arbitrates create/retry and destroy/retry requests against the same state', async () => {
    const { a } = await launchBoth();
    // Simulate database completion failure after a fully persisted apply; recovery keeps the original identity and state.
    await repository.updateRangeInstance(a.id, { status: 'create_failed', accessEntry: null });
    const creates = await Promise.allSettled([service.triggerCreate(a.id, alice), service.triggerRetry(a.id, alice)]);
    expect(creates.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    let pending = (await repository.listProvisionJobs()).filter(job => job.rangeInstanceId === a.id && ['pending', 'running'].includes(job.status));
    expect(pending).toHaveLength(1); await workers[0].process(pending[0].id);
    expect((await repository.getRangeInstanceById(a.id))!.status).toBe('running');
    await repository.updateRangeInstance(a.id, { status: 'destroy_failed' });
    const destroys = await Promise.allSettled([service.triggerDestroy(a.id, alice), service.triggerRetry(a.id, alice)]);
    expect(destroys.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    pending = (await repository.listProvisionJobs()).filter(job => job.rangeInstanceId === a.id && ['pending', 'running'].includes(job.status));
    expect(pending).toHaveLength(1); await workers[0].process(pending[0].id);
    expect((await repository.getRangeInstanceById(a.id))!.status).toBe('destroyed');
  });

  it('does not enqueue expiry or control a node while an update is pending', async () => {
    const { a } = await launchBoth();
    const saved = await service.saveDraft(a.id, draftInput(compile(graph())), alice);
    const update = await service.applyDraft(a.id, { expectedDraftRevision: saved.draftRevision!, previewToken: (await service.previewDraft(a.id, { expectedDraftRevision: saved.draftRevision! }, alice)).previewToken }, alice);
    await repository.updateRangeInstance(a.id, { expiresAt: new Date(Date.now() - 1000) });
    const actions = new RangeInstanceNodeActionsService(repository, config, {} as PackedImagesService);
    await expect(actions.run(a.id, 'dmz-entry', 'stop', {}, alice)).rejects.toMatchObject({ status: 409 });
    await workers[0].processExpiredInstances(new Date());
    expect((await repository.listProvisionJobs()).filter(job => job.rangeInstanceId === a.id && ['pending', 'running'].includes(job.status))).toHaveLength(1);
    await workers[0].process(update.id); await workers[0].processExpiredInstances(new Date());
    expect((await repository.getRangeInstanceById(a.id))!.status).toBe('pending_destroy');
    expect((await repository.listProvisionJobs()).filter(job => job.rangeInstanceId === a.id && ['pending', 'running'].includes(job.status))).toHaveLength(1);
  });

  it('rejects foreign private/disabled images for newly added hosts while preserving already deployed hosts', async () => {
    const { a } = await launchBoth();
    const edited = graph(); const added = structuredClone(edited.nodes.find((node: any) => node.id === 'office-backend'));
    added.id = 'new-backend'; added.privateIp = '10.0.20.30'; added.nics[0].id = 'new-backend-nic'; added.nics[0].privateIp = added.privateIp;
    edited.nodes.push(added); edited.edges.push({ id: 'office-new', fromNodeId: 'switch-office', toNodeId: added.id, relationType: 'manual' });
    await prisma.platformImageAsset.update({ where: { id: asset.id }, data: { visibility: 'private', ownerUserId: bob.id } });
    await expect(service.saveDraft(a.id, draftInput(compile(edited)), alice)).rejects.toMatchObject({ status: 403 });
    await prisma.platformImageAsset.update({ where: { id: asset.id }, data: { visibility: 'platform', ownerUserId: alice.id } });
    const saved = await service.saveDraft(a.id, draftInput(compile(edited)), alice);
    const preview = await service.previewDraft(a.id, { expectedDraftRevision: saved.draftRevision! }, alice);
    await prisma.platformImageAsset.update({ where: { id: asset.id }, data: { enabled: false } });
    await expect(service.applyDraft(a.id, { expectedDraftRevision: saved.draftRevision!, previewToken: preview.previewToken }, alice)).rejects.toMatchObject({ status: 400 });
    expect((await repository.listProvisionJobs()).filter(job => job.rangeInstanceId === a.id && job.jobType === 'update')).toHaveLength(0);
  });

  it('generates credentials for newly added ECS while preserving existing passwords and keeping them out of public jobs', async () => {
    const { a } = await launchBoth();
    const edited = graph();
    const added = JSON.parse(JSON.stringify(edited.nodes.find((node: any) => node.id === 'office-backend')));
    added.customPassword = 'ChangedFixture123!'; added.id = 'new-backend'; added.privateIp = '10.0.20.30'; added.nics[0].id = 'new-backend-nic'; added.nics[0].privateIp = added.privateIp; added.nics[0].securityGroupRules[0].key = 'new-backend-internal';
    edited.nodes.push(added); edited.edges.push({ id: 'office-new', fromNodeId: 'switch-office', toNodeId: added.id, relationType: 'manual' });
    const saved = await service.saveDraft(a.id, draftInput(compile(edited)), alice);
    const job = await service.applyDraft(a.id, { expectedDraftRevision: saved.draftRevision!, previewToken: (await service.previewDraft(a.id, { expectedDraftRevision: saved.draftRevision! }, alice)).previewToken }, alice); await workers[0].process(job.id);
    expect((await repository.getProvisionJobById(job.id))!.status).toBe('succeeded');
    const instance = (await repository.getRangeInstanceById(a.id))!;
    expect(Object.keys(instance.runtimeCredentials!)).toEqual(expect.arrayContaining(['dmz-entry', 'office-backend', 'new-backend']));
    expect(instance.runtimeCredentials!['new-backend'].password === 'ChangedFixture123!').toBe(true);
    expect(instance.runtimeCredentials!['dmz-entry'].password === a.runtimeCredentials!['dmz-entry'].password).toBe(true);
    expect(instance.runtimeCredentials!['office-backend'].password === a.runtimeCredentials!['office-backend'].password).toBe(true);
    const vars = JSON.parse(await fs.readFile(path.join(root, a.id, 'range.auto.tfvars.json'), 'utf8'));
    expect(Object.keys(vars.host_passwords)).toHaveLength(3);
    expect(vars.host_passwords['dmz-entry'] === instance.runtimeCredentials!['dmz-entry'].password).toBe(true);
    const publicJob = await new ProvisionJobsService(repository).getById(job.id, alice);
    expect(JSON.stringify(publicJob).includes('ChangedFixture123!')).toBe(false);
  });

  it('rejects stale claim writes and cancels a superseded queued update before touching its workspace', async () => {
    const { a } = await launchBoth();
    const saved = await service.saveDraft(a.id, draftInput(compile(graph())), alice);
    const update = await service.applyDraft(a.id, { expectedDraftRevision: saved.draftRevision!, previewToken: (await service.previewDraft(a.id, { expectedDraftRevision: saved.draftRevision! }, alice)).previewToken }, alice);
    const oldStart = new Date(Date.now() - 600000); await repository.claimRangeProvisionJob(update.id, oldStart);
    await repository.heartbeatRangeProvisionJob(update.id, oldStart, oldStart);
    await repository.requeueInterruptedProvisionJobs(new Date(Date.now() - 300000));
    const newStart = new Date(); await repository.claimRangeProvisionJob(update.id, newStart);
    expect(await repository.updateRangeInstanceForProvisionJob(update.id, oldStart, { name: 'stale overwrite', resourceSummary: null })).toBeNull();
    expect((await repository.getRangeInstanceById(a.id))!.resourceSummary).toMatchObject({ creationAttempted: true, executionContext: { cloudAccountUid: 'test-account' } });
    expect(await repository.updateRangeProvisionJob(update.id, oldStart, { status: 'failed' })).toBe(false);
    expect((await repository.getRangeInstanceById(a.id))!.name).not.toBe('stale overwrite');
    const stale = await repository.createProvisionJob({ rangeInstanceId: a.id, jobType: 'update', triggeredBy: alice.id,
      topologySnapshot: (await repository.getProvisionJobById(update.id))!.topologySnapshot as ProvisionJobTopologySnapshot,
    });
    const count = apply.mock.calls.length;
    await workers[1].process(stale.id);
    expect((await repository.getProvisionJobById(stale.id))!.status).toBe('cancelled');
    expect(apply.mock.calls).toHaveLength(count);
  });

  it('preserves entry protocols and the deployed OS login when image metadata later changes', async () => {
    const { a } = await launchBoth();
    const saved = await service.saveDraft(a.id, draftInput(compile(graph(), { publicEntryProtocols: [{ protocol: 'http', port: 8080 }] })), alice);
    const job = await service.applyDraft(a.id, { expectedDraftRevision: saved.draftRevision!, previewToken: (await service.previewDraft(a.id, { expectedDraftRevision: saved.draftRevision! }, alice)).previewToken }, alice); await workers[0].process(job.id);
    expect((await service.getById(a.id, alice)).runtimeTopologySpec).toMatchObject({ publicEntry: { protocols: [{ protocol: 'http', port: 8080 }] } });
    const snapshot = await repository.getImageSnapshotById(asset.sourceSnapshotId);
    await prisma.cloudImageSnapshot.update({ where: { id: snapshot!.id }, data: { osType: 'windows' } });
    const next = await service.saveDraft(a.id, draftInput(compile(graph()), (await repository.getRangeInstanceById(a.id))!.draftRevision!), alice);
    const windowsJob = await service.applyDraft(a.id, { expectedDraftRevision: next.draftRevision!, previewToken: (await service.previewDraft(a.id, { expectedDraftRevision: next.draftRevision! }, alice)).previewToken }, alice); await workers[0].process(windowsJob.id);
    expect((await repository.getRangeInstanceById(a.id))!.runtimeCredentials!['dmz-entry'].username).toBe(a.runtimeCredentials!['dmz-entry'].username);
    const vnc = await new RangeInstanceNodeActionsService(repository, config, {} as PackedImagesService).run(a.id, 'dmz-entry', 'open-vnc', {}, alice);
    expect((vnc as { webTerminalUrl: string }).webTerminalUrl).toContain('isWindows=true');
  });
});
