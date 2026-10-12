import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostCloudReleaseDeadline, assertCloudReleaseDeadlineCanCreate, verifyCloudReleaseDeadlines } from '../src/provisioning/cloud-release-deadlines';
import { OpenTofuRangeProvisioner, networkPreparationTargets, assertNetworkPreparationPlan } from '../src/provisioning/open-tofu-range-provisioner';
import { imageRpc } from '../src/admin/aliyun-image-rpc';
import { requestTencentCloud } from '../src/admin/tencent-cloud-client';
import type { HostCloudReleaseDeadline } from '../src/admin/admin.repository';

jest.mock('../src/admin/aliyun-image-rpc', () => ({ ...jest.requireActual('../src/admin/aliyun-image-rpc'), imageRpc: jest.fn() }));
jest.mock('../src/admin/tencent-cloud-client', () => ({ ...jest.requireActual('../src/admin/tencent-cloud-client'), requestTencentCloud: jest.fn() }));
const account = { provider: 'alibaba_cloud' as const, accountUid: '123456', cloudAccountContextId: 'account-a', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'test-key', accessKeySecret: 'test-secret' };
const C = '2026-10-13T02:00:17Z';
const deadline = (minutes = 10, provider: 'alibaba_cloud' | 'tencent_cloud' = 'alibaba_cloud') => createHostCloudReleaseDeadline({ provider, creationPhaseStartedAt: C, platformExpiresAt: new Date(Date.parse(C) + minutes * 60_000).toISOString(), sourceProvisionJobId: 'job-create' });

afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });
describe('immutable cloud release deadline', () => {
  it.each([[10, '2026-10-13T02:33:00Z'], [20, '2026-10-13T02:33:00Z'], [29, '2026-10-13T02:35:00Z'], [60, '2026-10-13T03:06:00Z']])('keeps platform expiry and computes the %i-minute Alibaba fallback with minute rounding', (minutes, cloudReleaseAt) => {
    const record = deadline(minutes as number); expect(record.cloudReleaseAt).toBe(cloudReleaseAt); expect(record.platformExpiresAt).toBe(new Date(Date.parse(C) + Number(minutes) * 60_000).toISOString());
  });
  it('uses the actual later host phase rather than the original accepted time', () => {
    const record = createHostCloudReleaseDeadline({ provider:'alibaba_cloud', platformExpiresAt:'2026-10-13T02:20:00Z', creationPhaseStartedAt:'2026-10-13T02:15:41Z', sourceProvisionJobId:'job' });
    expect(record.cloudReleaseAt).toBe('2026-10-13T02:48:00Z');
    expect(record.creationPhaseStartedAt).toBe('2026-10-13T02:15:41.000Z');
  });
  it('normalizes explicit Beijing offset to UTC and rejects local time or an expired launch', () => {
    expect(createHostCloudReleaseDeadline({ provider:'alibaba_cloud',platformExpiresAt:'2026-10-13T10:10:17+08:00', creationPhaseStartedAt:'2026-10-13T10:00:17+08:00', sourceProvisionJobId:'job' }).cloudReleaseAt).toBe(deadline().cloudReleaseAt);
    expect(() => createHostCloudReleaseDeadline({provider:'alibaba_cloud',platformExpiresAt:'2026-10-13T02:10:17',creationPhaseStartedAt:C,sourceProvisionJobId:'job'})).toThrow('timezone');
    expect(() => createHostCloudReleaseDeadline({provider:'alibaba_cloud',platformExpiresAt:C,creationPhaseStartedAt:C,sourceProvisionJobId:'job'})).toThrow('expiry');
  });
  it('does not extend a frozen deadline when a retry is too late', () => {
    const record = deadline(60), before = structuredClone(record);
    expect(() => assertCloudReleaseDeadlineCanCreate(record,new Date('2026-10-13T02:37:00Z'))).toThrow('cannot be extended'); expect(record).toEqual(before);
    expect(() => assertCloudReleaseDeadlineCanCreate(deadline(),new Date('2026-10-13T02:10:17Z'))).toThrow('expiry');
  });
  it('uses Tencent T+5 and checks Tencent constraints separately', () => {
    const record = deadline(10,'tencent_cloud'); expect(record.cloudReleaseAt).toBe('2026-10-13T02:15:17Z');
    expect(() => assertCloudReleaseDeadlineCanCreate(record,new Date('2026-10-13T02:09:59Z'))).not.toThrow();
    expect(() => assertCloudReleaseDeadlineCanCreate(record,new Date('2026-10-13T02:10:03Z'))).toThrow('cannot be extended');
  });
});

describe('native fallback readback', () => {
  it('verifies Alibaba only from exact IDs and native absolute times, accepting minute-form API output', async () => {
    (imageRpc as jest.Mock).mockResolvedValue({TotalCount:2,Instances:{Instance:[{InstanceId:'i-first',AutoReleaseTime:'2026-10-13T02:33Z'},{InstanceId:'i-second',AutoReleaseTime:'2026-10-13T04:00Z'}]}});
    const records=await verifyCloudReleaseDeadlines({account,hostIds:{a:'i-first',b:'i-second'},deadlines:{a:deadline(),b:deadline()}});
    expect(records.a.status).toBe('verified'); expect(records.b).toMatchObject({status:'unverified',reason:'timer_mismatch'});
    expect((imageRpc as jest.Mock).mock.calls[0][2].InstanceIds).toBe('["i-first","i-second"]');
  });
  it.each(['failed','incomplete','foreign'])('keeps Alibaba %s reads unverified without deleting or recreating anything', async mode => {
    if(mode==='failed') (imageRpc as jest.Mock).mockRejectedValue(new Error('vendor data must not be shown'));
    else (imageRpc as jest.Mock).mockResolvedValue({TotalCount: mode==='incomplete'?2:1,Instances:{Instance:[{InstanceId:mode==='foreign'?'i-foreign':'i-first',AutoReleaseTime:deadline().cloudReleaseAt}]}});
    const result=await verifyCloudReleaseDeadlines({account,hostIds:{a:'i-first'},deadlines:{a:deadline()}});
    expect(result.a).toMatchObject({status:'unverified',reason:'native_timer_check_failed'}); expect(JSON.stringify(result)).not.toContain('vendor data');
  });
  it('distinguishes an absent native timer from verified fallback', async () => {
    (imageRpc as jest.Mock).mockResolvedValue({TotalCount:1,Instances:{Instance:[{InstanceId:'i-first'}]}});
    expect((await verifyCloudReleaseDeadlines({account,hostIds:{a:'i-first'},deadlines:{a:deadline()}})).a.status).toBe('not_configured');
  });
  it.each(['UNDO','DOING','DONE'])('verifies only an unexecuted exact Tencent termination timer (%s)', async status => {
    (requestTencentCloud as jest.Mock).mockResolvedValue({ActionTimers:[{InstanceId:'ins-first',ActionTimerId:'timer-a',TimerAction:'TerminateInstances',ActionTime:deadline(10,'tencent_cloud').cloudReleaseAt,Status:status}]});
    const result=await verifyCloudReleaseDeadlines({account:{...account,provider:'tencent_cloud'},hostIds:{a:'ins-first'},deadlines:{a:deadline(10,'tencent_cloud')}});
    expect(result.a.status).toBe(status==='UNDO'?'verified':'unverified'); expect((requestTencentCloud as jest.Mock).mock.calls[0][0]).toMatchObject({action:'DescribeInstancesActionTimer',parameters:{InstanceIds:['ins-first']}});
  });
  it('does not accept duplicate timers or duplicate native host IDs', async () => {
    const timer={InstanceId:'ins-first',ActionTimerId:'a',TimerAction:'TerminateInstances',ActionTime:deadline(10,'tencent_cloud').cloudReleaseAt,Status:'UNDO'};
    (requestTencentCloud as jest.Mock).mockResolvedValue({ActionTimers:[timer,{...timer,ActionTimerId:'b'}]});
    expect((await verifyCloudReleaseDeadlines({account:{...account,provider:'tencent_cloud'},hostIds:{a:'ins-first'},deadlines:{a:deadline(10,'tencent_cloud')}})).a.status).toBe('unverified');
    expect((await verifyCloudReleaseDeadlines({account,hostIds:{a:'i-first',b:'i-first'},deadlines:{a:deadline()}})).a).toMatchObject({status:'unverified',reason:'instance_identity_unavailable'});
  });
});

describe('host network staging safety', () => {
  const resource = (type:string,actions:string[]=['create']) => ({address:`module.range.${type}.range`,type,mode:'managed',change:{actions}});
  it('targets only newly created network resources, never hosts, mappings or attachment operations', () => {
    const changes=[resource('alicloud_vpc'),resource('alicloud_security_group'),resource('alicloud_instance'),resource('alicloud_forward_entry'),resource('alicloud_network_interface_attachment'),resource('alicloud_vswitch',['update'])];
    expect(networkPreparationTargets({resource_changes:changes})).toEqual([changes[0].address,changes[1].address]);
  });
  it.each([resource('alicloud_instance'),resource('alicloud_vswitch',['delete']),resource('alicloud_security_group',['delete','create'])])('rejects a targeted plan containing unsafe resource $type', unsafe => {
    const original={resource_changes:[unsafe]}; expect(() => assertNetworkPreparationPlan(original,original)).toThrow('unapproved');
  });
  it('rejects a foreign resource or an unapproved dependency update', () => {
    expect(() => networkPreparationTargets({resource_changes:[{...resource('alicloud_vpc'),address:'module.foreign.alicloud_vpc.range'}]})).toThrow('foreign');
    expect(() => assertNetworkPreparationPlan({resource_changes:[resource('alicloud_vswitch',['update'])]},{resource_changes:[]})).toThrow('unapproved');
  });
  it('persists host-phase absolute deadlines once and preserves old nodes when dynamically adding another', async () => {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'release-deadlines-'));
    const provisioner=new OpenTofuRangeProvisioner({env:{}}) as any;
    const first=deadline(60); const futureExpiry=new Date(Date.now()+50*60_000).toISOString();
    const known={...first,platformExpiresAt:futureExpiry};
    await fs.writeFile(path.join(dir,'host-cloud-release-deadlines.json'),JSON.stringify({old:known}));
    const persist=jest.fn(async()=>undefined);
    const input={expiresAt:futureExpiry,billingTags:{PlatformCreateJobId:'job-new'},runtimeConfig:account,knownResourceSummary:{cloudReleaseDeadlines:{old:known}},onHostCreationPhase:persist};
    try {
      const records=await provisioner.freezeHostDeadlines(input,{workspaceDir:dir},['new']);
      expect(records.old).toEqual(known); expect(records.new.sourceProvisionJobId).toBe('job-new'); expect(records.new.platformExpiresAt).toBe(futureExpiry);
      const again=await provisioner.freezeHostDeadlines({...input,billingTags:{PlatformCreateJobId:'job-retry'}},{workspaceDir:dir},['new']);
      expect(again.new).toEqual(records.new); expect(persist).toHaveBeenCalledTimes(2);
      const bad={...input,knownResourceSummary:{cloudReleaseDeadlines:{old:{...known,cloudReleaseAt:'2026-11-01T00:00:00Z'}}}};
      await expect(provisioner.freezeHostDeadlines(bad,{workspaceDir:dir},['new'])).rejects.toThrow('conflicts');
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  });
});

describe('range host phase execution', () => {
  it('prepares network before C, persists the exact deadline before host apply and checks native configuration', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'host-phase-')); const dir=path.join(root,'workspaces','range-test');
    await fs.mkdir(path.join(root,'infra/module'),{recursive:true});
    const expiry=new Date(Date.now()+10*60_000).toISOString();
    const tags={CloudProvider:'alibaba_cloud',CloudAccountUid:account.accountUid,CloudAccountContextId:account.cloudAccountContextId,RangeInstanceId:'range-test',range_instance_id:'range-test',PlatformCreateJobId:'job-create',CreatedBy:'cyber-range-platform',PlatformManaged:'true',PlatformScope:'user',PlatformUserId:'owner'};
    const addresses=['module.range.alicloud_vpc.range','module.range.alicloud_security_group.hosts["a"]','module.range.alicloud_instance.hosts["a"]'];
    const kinds=['alicloud_vpc','alicloud_security_group','alicloud_instance'];
    let networkApplied=false;
    const plan=(network:boolean)=>({format_version:'1.2',terraform_version:'1.13.1',errored:false,resource_changes:addresses.slice(0,network?2:3).map((address,index)=>({address,type:kinds[index],mode:'managed',change:{actions:[!network && networkApplied && index<2?'no-op':'create']}})),planned_values:{root_module:{resources:addresses.slice(0,network?2:3).map(address=>({address,mode:'managed'}))}}});
    const state=(network:boolean)=>({version:4,lineage:'lineage-a',serial:network?1:2,resources:kinds.slice(0,network?2:3).map((type,index)=>({module:'module.range',type,name:index===0?'range':'hosts',mode:'managed',instances:[{...(index===0?{}:{index_key:'a'}),attributes:{id:['vpc-a','sg-a','i-a'][index],tags,...(index===2?{system_disk_id:'d-a'}:{})}}]}))});
    const events:string[]=[]; let firstApplyDoneAt=0; let frozen:Record<string,HostCloudReleaseDeadline>|undefined;
    const runner={
      init:jest.fn(async()=>{events.push('init');return {stdout:'',stderr:''};}),
      plan:jest.fn(async(options:any)=>{events.push(options.targets?'network-plan':'full-plan');return {stdout:'',stderr:''};}),
      showPlan:jest.fn(async(options:any)=>plan(options.planFilePath.endsWith('host-network.tfplan'))),
      apply:jest.fn(async(options:any)=>{
        const network=options.planFilePath.endsWith('host-network.tfplan');events.push(network?'network-apply':'host-apply');
        if(!network){expect(frozen?.a.cloudReleaseAt).toBeTruthy();expect(Date.parse(frozen!.a.creationPhaseStartedAt)).toBeGreaterThanOrEqual(firstApplyDoneAt);expect(frozen!.a.platformExpiresAt).toBe(expiry);const variables=JSON.parse(await fs.readFile(path.join(dir,'range.auto.tfvars.json'),'utf8'));expect(variables.hosts[0].auto_release_time).toBe(frozen!.a.cloudReleaseAt);}
        await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify(state(network)));if(network){firstApplyDoneAt=Date.now();networkApplied=true;}return {stdout:'',stderr:''};
      }),
      output:jest.fn(async()=>({resource_summary:{value:{vpc_id:'vpc-a',security_group_ids:{a:'sg-a'},host_ids:{a:'i-a'}}}})),
    };
    const provisioner=new OpenTofuRangeProvisioner({projectRootDir:root,workspacesRootDir:path.join(root,'workspaces'),runner:runner as any,env:{}}) as any;
    jest.spyOn(provisioner,'buildVariables').mockResolvedValue({hosts:[{key:'a',instance_type:'ecs.type',image_id:'m-a'}],tags});jest.spyOn(provisioner,'buildRunnerEnv').mockResolvedValue({});
    (imageRpc as jest.Mock).mockImplementation(async()=>({TotalCount:1,Instances:{Instance:[{InstanceId:'i-a',AutoReleaseTime:frozen!.a.cloudReleaseAt}]}}));
    try {
      const result=await provisioner.create({rangeInstanceId:'range-test',templateModulePath:'infra/module',allocatedCidr:null,expiresAt:expiry,runtimeConfig:account,billingTags:tags,onHostCreationPhase:async(records:any)=>{events.push('freeze');frozen=records;},topologySpec:{vpcCidr:'10.0.0.0/16',networkZones:[{key:'main',name:'Main',purpose:'internal',cidr:'10.0.0.0/24'}],hosts:[{key:'a',name:'A',zoneKey:'main',role:'entry',privateIp:'10.0.0.10'}],publicEntry:{hostKey:'a',protocols:[]}}});
      expect(events.indexOf('network-apply')).toBeLessThan(events.indexOf('freeze'));expect(events.indexOf('freeze')).toBeLessThan(events.indexOf('host-apply'));expect(result.resourceSummary.cloudReleaseDeadlines.a.status).toBe('verified'); expect(runner.apply).toHaveBeenCalledTimes(2);
      expect(await fs.readFile(path.join(dir,'host-cloud-release-deadlines.json'),'utf8')).toContain(frozen!.a.cloudReleaseAt);
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });
});
