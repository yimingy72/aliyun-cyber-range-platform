import { assertApprovedRangeUpdatePlan, preserveDeployedRangeHostFacts, type RangeChangeApproval } from '../src/provisioning/range-update-plan-safety';
import type { WorkspaceState } from '../src/provisioning/opentofu-state-evidence';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import { buildEnterpriseProvisionPlan } from '../src/provisioning/enterprise-provision-plan';
import * as tencentScheduler from '../src/provisioning/tencent-cloud-zone-instance-scheduler';

function fixture(tencent: boolean) {
  const account = { provider: tencent ? 'tencent_cloud' as const : 'alibaba_cloud' as const, accountUid: 'owned-account', cloudAccountContextId: 'owned-context', defaultRegion: tencent ? 'ap-nanjing' : 'cn-hangzhou', defaultZoneId: tencent ? 'ap-nanjing-1' : 'cn-hangzhou-h', accessKeyId: 'fixture', accessKeySecret: 'fixture' };
  const tags = { CloudProvider: account.provider, CloudAccountUid: account.accountUid, CloudAccountContextId: account.cloudAccountContextId, RangeInstanceId: 'range-owned', CreatedBy: 'cyber-range-platform', PlatformScope: 'user', PlatformUserId: 'owner' };
  const prior: Record<string, any> = { tags, region: account.defaultRegion, zone_id: account.defaultZoneId, resource_name_prefix: 'owned', vpc_cidr: '10.0.0.0/16', secondary_vpc_cidrs: [], network_zones: [{ key: 'main', cidr: '10.0.0.0/24', name: 'main' }], hosts: [{ key: 'old', name: 'Old', zone_key: 'main', private_ip: '10.0.0.10', instance_type: 'original-type', image_id: 'original-image', system_disk_size: 50, system_disk_type: 'CLOUD_PREMIUM', user_data: 'original bytes', terminate_at: '2026-12-10T00:00:00Z', creation_intent_id: 'old-intent' }], host_passwords: { old: 'Original123!' }, host_network_interfaces: [{ host_key: 'old', interfaces: [{ nic_id: 'nic-main', device_index: 0, zone_key: 'main', private_ip: '10.0.0.10' }] }], network_interfaces: [{ key: 'old-0', host_key: 'old', device_index: 0, zone_key: 'main', private_ip: '10.0.0.10', secondary_ips: [] }], security_group_rules: [], acls: [], nat_gateways: [], eips: [], snat_entries: [], dnat_entries: [], system_disk_size: 50, system_disk_category: 'cloud_essd', image_id: 'original-image', instance_type: 'original-type' };
  const names: Array<[string, string, string | null, string]> = tencent ? [
    ['tencentcloud_vpc','range',null,'vpc-owned'], ['tencentcloud_subnet','zones','main','subnet-owned'], ['tencentcloud_route_table','zones','main','rtb-owned'], ['tencentcloud_route_table_association','zones','main','assoc-owned'], ['tencentcloud_instance','hosts','old','ins-owned'], ['tencentcloud_security_group','nics','old-0','sg-owned'], ['tencentcloud_security_group_rule_set','nics','old-0','sg-owned'],
  ] : [ ['alicloud_vpc','range',null,'vpc-owned'], ['alicloud_vswitch','zones','main','vsw-owned'], ['alicloud_instance','hosts','old','i-owned'], ['alicloud_security_group','hosts','old','sg-owned'] ];
  const state: WorkspaceState = { lineage: 'owned-lineage', serial: 1, instances: names.map(([type, name, key, id]) => ({ address: `module.range.${type}.${name}${key === null ? '' : `[${JSON.stringify(key)}]`}`, type, module: 'module.range', tainted: false, attributes: { id, ...(type.includes('instance') ? { tags, availability_zone: account.defaultZoneId, image_id: 'original-image', instance_type: 'original-type', private_ip: '10.0.0.10', system_disk_size: 50, user_data: 'original bytes' } : type.includes('association') || type.includes('rule_set') ? {} : { tags }) } })) };
  const plan: any = { format_version: '1.2', terraform_version: '1.13.1', errored: false, complete: true, planned_values: { root_module: { child_modules: [{ address: 'module.range', resources: state.instances.map(resource => ({ address: resource.address, type: resource.type, mode: 'managed' })) }] } }, resource_changes: state.instances.map(resource => ({ address: resource.address, type: resource.type, mode: 'managed', change: { actions: ['no-op'], before: structuredClone(resource.attributes), after: structuredClone(resource.attributes), after_unknown: {} } })) };
  const approval: RangeChangeApproval = { version: 1, addedHostKeys: [], deletedHostKeys: [], runtimeIdentityDigest: 'a'.repeat(43), topologyDigest: 'b'.repeat(43), allowDnatRemoval: false, allowSnatRemoval: false };
  const knownResourceSummary = { mode:'opentofu' as const, executionContext:{provider:account.provider,cloudAccountUid:account.accountUid,cloudAccountContextId:account.cloudAccountContextId,regionId:account.defaultRegion,zoneId:account.defaultZoneId},vpcId:'vpc-owned',subnetIds:{main:tencent?'subnet-owned':'vsw-owned'},hostIds:{old:tencent?'ins-owned':'i-owned'},securityGroupIds:{[tencent?'old-0':'old']:'sg-owned'},...(tencent ? {routeTableIds:{main:'rtb-owned'}} : {}),natGatewayIds:{},eipAllocationIds:{},dnatEntryIds:{} };
  const input = { plan, state, priorVariables: prior, nextVariables: structuredClone(prior), approval, account, rangeInstanceId: 'range-owned', billingTags: tags, knownResourceSummary };
  return { ...input, input };
}
const vm = (f: ReturnType<typeof fixture>) => f.plan.resource_changes.find((resource: any) => resource.type.endsWith('_instance'));

describe.each([false, true])('approved runtime update safety, Tencent=%s', tencent => {
  it('accepts a complete same-identity no-op plan', () => expect(() => assertApprovedRangeUpdatePlan(fixture(tencent).input)).not.toThrow());
  it.each(['image_id','instance_type','system_disk_size','private_ip','user_data','password','availability_zone'])('rejects implicit VM change in %s', field => {
    const f = fixture(tencent); vm(f).change.actions = ['update']; vm(f).change.after[field] = 'changed';
    expect(() => assertApprovedRangeUpdatePlan(f.input)).toThrow('existing host configuration');
  });
  it.each([{actions:['delete','create']},{actions:['create','delete']},{actions:['create']},{actions:['delete']}])('rejects implicit VM action %j', ({actions}) => {
    const f = fixture(tencent); vm(f).change.actions = actions;
    expect(() => assertApprovedRangeUpdatePlan(f.input)).toThrow();
  });
  it('rejects absent, tainted or foreign native identity', () => {
    for (const mutation of [(f: any) => vm(f).change.before.id = 'foreign', (f: any) => f.state.instances.find((entry: any) => entry.type.endsWith('_instance')).tainted = true, (f: any) => f.priorVariables.tags.CloudAccountUid = 'other', (f: any) => vm(f).address = 'module.other.hosts["old"]']) {
      const f = fixture(tencent); mutation(f); expect(() => assertApprovedRangeUpdatePlan(f.input)).toThrow();
    }
  });
  it('rejects state identities that differ from the platform ledger even when state tags appear owned', () => {
    const f=fixture(tencent); f.knownResourceSummary.hostIds.old=tencent?'ins-other':'i-other'; expect(()=>assertApprovedRangeUpdatePlan(f.input)).toThrow('platform inventory');
  });
  it('rejects incomplete, deferred, duplicate or omitted resource actions', () => {
    for (const mutate of [(f: any) => f.plan.complete = false, (f: any) => f.plan.deferred_changes = [{}], (f: any) => f.plan.resource_changes.pop(), (f: any) => f.plan.resource_changes.push(f.plan.resource_changes[0]), (f: any) => f.plan.planned_values.root_module.child_modules[0].resources.push({address:'module.range.unknown.resource',mode:'managed'})]) {
      const f = fixture(tencent); mutate(f); expect(() => assertApprovedRangeUpdatePlan(f.input)).toThrow();
    }
  });
  it('permits ownership tags to change without replacing an existing VM', () => {
    const f = fixture(tencent); vm(f).change.actions = ['update']; vm(f).change.after.tags.PlatformCreateJobId = 'new-job';
    expect(() => assertApprovedRangeUpdatePlan(f.input)).not.toThrow();
  });
  it('permits an explicit deleted host and its own security group, retaining VPC and subnet', () => {
    const f = fixture(tencent); f.approval.deletedHostKeys = ['old']; f.nextVariables.hosts = []; f.nextVariables.host_network_interfaces = []; f.nextVariables.network_interfaces = [];
    const deleting = f.plan.resource_changes.filter((entry: any) => ['alicloud_instance','tencentcloud_instance','alicloud_security_group','tencentcloud_security_group','tencentcloud_security_group_rule_set'].includes(entry.type));
    for (const entry of deleting) { entry.change.actions = ['delete']; entry.change.after = null; }
    f.plan.planned_values.root_module.child_modules[0].resources = f.plan.planned_values.root_module.child_modules[0].resources.filter((entry: any) => !deleting.some((item: any) => item.address === entry.address));
    expect(() => assertApprovedRangeUpdatePlan(f.input)).not.toThrow();
    f.approval.deletedHostKeys = []; expect(() => assertApprovedRangeUpdatePlan(f.input)).toThrow('confirmed preview');
  });
  it('permits a new explicitly approved host and rejects extra hidden hosts', () => {
    const f = fixture(tencent); f.approval.addedHostKeys = ['new']; f.nextVariables.hosts.push({ ...f.nextVariables.hosts[0], key:'new', private_ip:'10.0.0.20' });
    const entries = tencent ? [['tencentcloud_instance','hosts','new'], ['tencentcloud_security_group','nics','new-0'], ['tencentcloud_security_group_rule_set','nics','new-0']] : [['alicloud_instance','hosts','new'],['alicloud_security_group','hosts','new']];
    if (tencent) f.nextVariables.network_interfaces.push({...f.nextVariables.network_interfaces[0],key:'new-0',host_key:'new',private_ip:'10.0.0.20'}); else f.nextVariables.host_network_interfaces.push({host_key:'new',interfaces:[{device_index:0,zone_key:'main',private_ip:'10.0.0.20'}]});
    for (const [type,name,key] of entries) { const address = `module.range.${type}.${name}[${JSON.stringify(key)}]`; f.plan.planned_values.root_module.child_modules[0].resources.push({address,type,mode:'managed'}); f.plan.resource_changes.push({address,type,mode:'managed',change:{actions:['create'],before:null,after:{tags:f.billingTags},after_unknown:{id:true}}}); }
    expect(() => assertApprovedRangeUpdatePlan(f.input)).not.toThrow();
    f.approval.addedHostKeys = []; expect(() => assertApprovedRangeUpdatePlan(f.input)).toThrow('confirmed preview');
  });
  it('rejects VPC/subnet replacements even when host deletion was approved', () => {
    const f = fixture(tencent); const entry = f.plan.resource_changes.find((resource: any) => resource.type === (tencent ? 'tencentcloud_subnet' : 'alicloud_vswitch')); entry.change.actions = ['delete','create'];
    expect(() => assertApprovedRangeUpdatePlan(f.input)).toThrow('replacement');
  });
  it('permits confirmed public-entry retirement but forbids implicit EIP/NAT replacement', () => {
    const f=fixture(tencent);
    f.priorVariables.nat_gateways=[{key:'shared',zone_key:'main'}]; f.priorVariables.eips=[{key:'dnat-eip',nat_key:'shared',bind_target_type:'nat_gateway',bind_target_key:'shared'}]; f.priorVariables.dnat_entries=[{key:'entry',nat_key:'shared',nat_gateway_key:'shared',eip_key:'dnat-eip',host_key:'old',backend_host_key:'old'}];
    Object.assign(f.knownResourceSummary,{natGatewayIds:{shared:tencent?'nat-owned':'ngw-owned'},eipAllocationIds:{'dnat-eip':'eip-owned'},dnatEntryIds:{entry:'dnat-owned'}});
    const records = tencent ? [['tencentcloud_nat_gateway','shared','shared','nat-owned'],['tencentcloud_eip','range','dnat-eip','eip-owned'],['tencentcloud_dnat','entry','entry','dnat-owned']] : [['alicloud_nat_gateway','gateways','shared','ngw-owned'],['alicloud_eip_address','addresses','dnat-eip','eip-owned'],['alicloud_eip_association','nat_targets','dnat-eip','assoc-eip-owned'],['alicloud_forward_entry','entries','entry','dnat-owned']];
    for(const [type,name,key,id] of records) { const address=`module.range.${type}.${name}[${JSON.stringify(key)}]`, attributes={id,...(!type.includes('association') && !type.includes('dnat') && !type.includes('forward_entry') ? {tags:f.billingTags} : {})}; f.state.instances.push({address,type,module:'module.range',tainted:false,attributes}); f.plan.resource_changes.push({address,type,mode:'managed',change:{actions:['delete'],before:attributes,after:null,after_unknown:{}}}); }
    expect(()=>assertApprovedRangeUpdatePlan(f.input)).toThrow('not confirmed');
    f.approval.allowDnatRemoval=true; expect(()=>assertApprovedRangeUpdatePlan(f.input)).not.toThrow();
    f.nextVariables.eips=structuredClone(f.priorVariables.eips); const eip=f.plan.resource_changes.find((record:any)=>record.type === (tencent ? 'tencentcloud_eip' : 'alicloud_eip_address')); eip.change.actions=['delete','create'];
    expect(()=>assertApprovedRangeUpdatePlan(f.input)).toThrow();
  });
  it('rejects a real provisioner plan before apply, command intent or callback is written', async () => {
    const f = fixture(tencent), root = await fs.mkdtemp(path.join(os.tmpdir(), 'range-update-guard-'));
    const modulePath = tencent ? 'infra/opentofu/modules/tencentcloud-enterprise-range' : 'infra/module';
    const dir = path.join(root,'workspaces','range-owned'); await fs.mkdir(path.join(root,modulePath),{recursive:true}); await fs.mkdir(dir,{recursive:true});
    const resources = f.state.instances.map(resource => { const match = resource.address.match(/^module\.range\.([^.]+)\.([^\[]+)(?:\[(.*)\])?$/)!; return {mode:'managed',module:'module.range',type:match[1],name:match[2],instances:[{...(match[3] ? {index_key:JSON.parse(match[3])} : {}),attributes:resource.attributes}]}; });
    await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify({version:4,lineage:f.state.lineage,serial:1,resources})); await fs.writeFile(path.join(dir,'range.auto.tfvars.json'),JSON.stringify({...f.priorVariables,bootstrap_scripts:[]}));
    if (tencent) await fs.writeFile(path.join(dir,'tencent-range-identity.json'),JSON.stringify({provider:f.account.provider,cloudAccountContextId:f.account.cloudAccountContextId,cloudAccountUid:f.account.accountUid,regionId:f.account.defaultRegion,zoneId:f.account.defaultZoneId,rangeInstanceId:'range-owned'}));
    vm(f).change.actions=['delete','create'];
    const runner = { init:jest.fn(async()=>({stdout:'',stderr:''})),plan:jest.fn(async()=>({stdout:'',stderr:''})),showPlan:jest.fn(async()=>f.plan),apply:jest.fn() };
    const provisioner = new OpenTofuRangeProvisioner({runner:runner as any,projectRootDir:root,workspacesRootDir:path.join(root,'workspaces')});
    jest.spyOn(provisioner as any,'buildVariables').mockResolvedValue({...f.nextVariables,bootstrap_scripts:[]}); jest.spyOn(provisioner as any,'buildRunnerEnv').mockResolvedValue({});
    const onApplyStart=jest.fn();
    try {
      await expect(provisioner.create({rangeInstanceId:'range-owned',templateModulePath:modulePath,allocatedCidr:null,runtimeConfig:f.account,runtimeCredentials:{old:{username:'root',password:'Original123!'}},billingTags:f.billingTags,knownResourceSummary:f.knownResourceSummary,preserveWorkspaceState:true,requirePersistedState:true,changeApproval:f.approval,onApplyStart,topologySpec:{vpcCidr:'10.0.0.0/16',networkZones:[{key:'main',name:'Main',purpose:'internal',cidr:'10.0.0.0/24'}],hosts:[{key:'old',name:'Old',zoneKey:'main',role:'entry',privateIp:'10.0.0.10'}],publicEntry:{hostKey:'old',protocols:[]}}})).rejects.toThrow('replacement');
      expect(runner.apply).not.toHaveBeenCalled(); expect(onApplyStart).not.toHaveBeenCalled(); await expect(fs.stat(path.join(dir,'.range-apply-started'))).rejects.toMatchObject({code:'ENOENT'});
      const persisted = JSON.parse(await fs.readFile(path.join(dir,'range.auto.tfvars.json'),'utf8')); expect(persisted.hosts[0]).toEqual(f.priorVariables.hosts[0]);
    } finally { await fs.rm(root,{recursive:true,force:true}); }
  });
  it('freezes old image, type, disk, password, startup bytes, placement and creation intent while leaving new hosts new', () => {
    const f = fixture(tencent); const next = f.nextVariables; next.hosts[0] = {...next.hosts[0], image_id:'new-rendered-image',instance_type:'new-type',system_disk_size:200,user_data:'new-script',creation_intent_id:'new-intent'}; next.host_passwords.old = 'NewPassword123!'; next.zone_id = 'new-zone'; next.system_disk_size = 200; next.hosts.push({...next.hosts[0],key:'new',private_ip:'10.0.0.20'});
    const result = preserveDeployedRangeHostFacts(f.state,f.priorVariables,next,f.account);
    expect(result.hosts[0]).toEqual(f.priorVariables.hosts[0]); expect(result.host_passwords.old).toBe('Original123!'); expect(result.hosts[1].system_disk_size).toBe(200); expect(result.zone_id).toBe(f.account.defaultZoneId);
    if (!tencent) expect(result.system_disk_size).toBe(50);
  });
  it('rejects host movement or existing NIC drift rather than silently applying it', () => {
    for (const mutate of [(next:any) => next.hosts[0].private_ip='10.0.0.99', (next:any) => next.network_zones[0].cidr='10.0.9.0/24', (next:any) => next[tencent?'network_interfaces':'host_network_interfaces']=[]]) {
      const f = fixture(tencent); mutate(f.nextVariables); expect(() => preserveDeployedRangeHostFacts(f.state,f.priorVariables,f.nextVariables,f.account)).toThrow();
    }
  });
});

describe('only newly added hosts are resolved during runtime updates', () => {
  afterEach(() => jest.restoreAllMocks());
  const topology = {vpcCidr:'10.0.0.0/16',networkZones:[{key:'main',name:'Main',purpose:'internal',cidr:'10.0.0.0/24'}],hosts:[{key:'old',name:'Old',zoneKey:'main',role:'entry',privateIp:'10.0.0.10'},{key:'new',name:'New',zoneKey:'main',role:'server',privateIp:'10.0.0.20'}],publicEntry:{hostKey:'old',protocols:[]}};
  const graph = {nodes:[{id:'old',kind:'ecs',cpu:2,memory:4,imageId:'img-old'},{id:'new',kind:'ecs',cpu:2,memory:4,imageId:'img-new'}]};
  it('Alibaba selects only added hosts within the original zone and retains old image/type without availability queries', async () => {
    const f=fixture(false), resolver=jest.fn(async(_input:any)=> 'ecs.new-type'); const provisioner=new OpenTofuRangeProvisioner({enableZoneScheduling:false,availableInstanceTypeResolver:resolver,env:{OPENTOFU_INSTANCE_TYPE:'auto'}});
    f.account.defaultZoneId='cn-hangzhou-a';
    const result=await (provisioner as any).buildVariables({rangeInstanceId:'range-owned',templateModulePath:'infra/module',allocatedCidr:null,runtimeConfig:f.account,topologySpec:topology,topologyGraph:graph,runtimeCredentials:{old:{password:'Original123!'},new:{password:'NewPassword123!'}}},{requireRuntimePasswords:true,priorState:f.state,priorVariables:f.priorVariables});
    expect(resolver).toHaveBeenCalledTimes(1); expect(resolver.mock.calls[0][0]).toMatchObject({zoneId:'cn-hangzhou-h'}); expect(result.hosts.find((host:any)=>host.key==='old')).toMatchObject({image_id:'original-image',instance_type:'original-type'}); expect(result.zone_id).toBe('cn-hangzhou-h');
  });
  it('Tencent image disk floor is per new host; retired/old images are not queried', async () => {
    const f=fixture(true), select=jest.spyOn(tencentScheduler,'selectTencentHostInstanceTypes').mockResolvedValue({new:{instanceType:'S5.MEDIUM4',cpu:2}}), images=jest.spyOn(tencentScheduler,'assertTencentImagesAvailable').mockResolvedValue({'img-new':{minimumSystemDiskSize:200,architecture:'x86_64',isWindows:false}});
    f.priorVariables.hosts[0].image_id='img-retired';
    const provisioner=new OpenTofuRangeProvisioner({workspacesRootDir:'/tmp/no-runtime-fixture-workspace',env:{}});
    const input={rangeInstanceId:'range-owned',templateModulePath:'infra/opentofu/modules/tencentcloud-enterprise-range',allocatedCidr:null,runtimeConfig:f.account,topologySpec:topology,topologyGraph:graph,compiledSpec:{resources:graph.nodes.map(node=>({id:node.id,type:'host',config:node})),topology:{}},expiresAt:new Date(Date.now()+3600000).toISOString(),runtimeCredentials:{old:{username:'root',password:'Original123!'},new:{username:'root',password:'NewPassword123!'}},billingTags:{...f.billingTags,PlatformCreateJobId:'update-job'}};
    const plan=buildEnterpriseProvisionPlan({...input,compiledSpec:undefined});
    const result=await (provisioner as any).buildTencentVariables(input,plan,f.account,{requireRuntimePasswords:true,priorState:f.state,priorVariables:f.priorVariables});
    expect(select.mock.calls[0][1].map(host=>host.key)).toEqual(['new']); expect(images.mock.calls[0][1]).toEqual(['img-new']);
    expect(result.hosts.find((host:any)=>host.key==='old')).toMatchObject({system_disk_size:50,image_id:'img-retired',instance_type:'original-type'}); expect(result.hosts.find((host:any)=>host.key==='new')).toMatchObject({system_disk_size:200});
  });
});
