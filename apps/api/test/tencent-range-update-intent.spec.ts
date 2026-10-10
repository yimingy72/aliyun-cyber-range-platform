import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';
import { renderTencentRangeVariables } from '../src/provisioning/renderers/tencent-cloud-range-renderer';
import type { EnterpriseProvisionPlan } from '../src/provisioning/enterprise-provision-plan';
import type { WorkspaceState } from '../src/provisioning/opentofu-state-evidence';

function fixture() {
  const account={provider:'tencent_cloud' as const,accountUid:'100000000001',cloudAccountContextId:'owned-context',defaultRegion:'ap-nanjing',defaultZoneId:'ap-nanjing-1',accessKeyId:'fixture',accessKeySecret:'fixture'};
  const tags={PlatformCreateJobId:'original-job',CloudProvider:account.provider,CloudAccountUid:account.accountUid,CloudAccountContextId:account.cloudAccountContextId,RangeInstanceId:'range-owned',CreatedBy:'cyber-range-platform',PlatformScope:'user',PlatformUserId:'owner'};
  const plan={resourceNamePrefix:'range-owned',entryHostKey:'old',network:{vpcCidr:'10.0.0.0/16',secondaryVpcCidrs:[]},networkZones:[{key:'main',name:'Main',cidr:'10.0.1.0/24'}],hostDefinitions:[{key:'old',name:'Old',hostName:'old',zoneKey:'main',privateIp:'10.0.1.10'}],hostNetworkInterfaces:[{hostKey:'old',interfaces:[{deviceIndex:0,zoneKey:'main',privateIp:'10.0.1.10'}]}],natGateways:[{key:'shared',name:'NAT',zoneKey:'main'}],eipDefinitions:[{key:'entry',name:'Entry',bindTargetType:'nat_gateway',bindTargetKey:'shared',bandwidthMbps:5}],snatEntries:[{key:'main',natGatewayKey:'shared',sourceZoneKey:'main',eipKey:'entry'}],dnatEntries:[{key:'http',natGatewayKey:'shared',eipKey:'entry',backendHostKey:'old',externalPort:80,internalPort:80,protocol:'tcp'}],securityGroupRules:[],aclDefinitions:[],bootstrapScripts:[]} as unknown as EnterpriseProvisionPlan;
  const rendering={plan,rangeInstanceId:'range-owned',account,hostInstanceTypes:{old:{instanceType:'S5.MEDIUM4',cpu:2}},hostImageIds:{old:'img-owned'},hostPasswords:{old:'FixturePassword123!'},tags,expiresAt:'2100-01-01T00:00:00Z'};
  const prior=renderTencentRangeVariables(rendering);
  const state:WorkspaceState={lineage:'owned',serial:1,instances:[
    {module:'module.range',type:'tencentcloud_instance',address:'module.range.tencentcloud_instance.hosts["old"]',tainted:false,attributes:{id:'ins-owned',tags:{...prior.tags,CreationIntentId:prior.hosts[0].creation_intent_id},availability_zone:account.defaultZoneId}},
    {module:'module.range',type:'tencentcloud_nat_gateway',address:'module.range.tencentcloud_nat_gateway.shared["shared"]',tainted:false,attributes:{id:'nat-owned',name:`${prior.resource_name_prefix}-${prior.nat_gateways[0].creation_intent_id.slice(0,16)}`,tags:{...prior.tags,CreationIntentId:prior.nat_gateways[0].creation_intent_id}}},
    {module:'module.range',type:'tencentcloud_eip',address:'module.range.tencentcloud_eip.range["entry"]',tainted:false,attributes:{id:'eip-owned',name:`${prior.resource_name_prefix}-${prior.eips[0].creation_intent_id.slice(0,16)}`,client_token:prior.eips[0].creation_intent_id,tags:{...prior.tags,CreationIntentId:prior.eips[0].creation_intent_id}}},
  ]};
  const input={rangeInstanceId:'range-owned',allocatedCidr:null,templateModulePath:'infra/opentofu/modules/tencentcloud-enterprise-range',runtimeConfig:account,expiresAt:rendering.expiresAt,runtimeCredentials:{old:{username:'root',password:'FixturePassword123!'}},compiledSpec:{resources:[{id:'old',type:'host',config:{cpu:2,memory:4,imageId:'img-owned'}}]},billingTags:{...tags,PlatformCreateJobId:'update-job'},knownResourceSummary:{mode:'opentofu' as const,natGatewayIds:{shared:'nat-owned'},eipAllocationIds:{entry:'eip-owned'}}};
  const provisioner=new OpenTofuRangeProvisioner({workspacesRootDir:'/tmp/unused-intent-fixture',env:{TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED:'1'}});
  const build=()=> (provisioner as any).buildTencentVariables(input,plan,account,{requireRuntimePasswords:true,priorState:state,priorVariables:prior});
  return {account,plan,rendering,prior,state,input,build};
}

describe('Tencent range updates retain exact network allocation intents',()=>{
  it('preserves old EIP client token and NAT/EIP names despite a new worker update job',async()=>{
    const f=fixture(); f.plan.dnatEntries[0].externalPort=18081;
    const result=await f.build();
    expect(result.nat_gateways[0].creation_intent_id).toBe(f.prior.nat_gateways[0].creation_intent_id);
    expect(result.eips[0].creation_intent_id).toBe(f.prior.eips[0].creation_intent_id);
    expect(`${result.resource_name_prefix}-${result.nat_gateways[0].creation_intent_id.slice(0,16)}`).toBe(f.state.instances[1].attributes.name);
    expect(`${result.resource_name_prefix}-${result.eips[0].creation_intent_id.slice(0,16)}`).toBe(f.state.instances[2].attributes.name);
    expect(result.eips[0].creation_intent_id).toBe(f.state.instances[2].attributes.client_token);
    expect(result.dnat_entries[0].external_port).toBe(18081);
    expect(result.tags.PlatformCreateJobId).toBe('update-job');
  });
  it('uses the current update job intent only for new EIP keys',async()=>{
    const f=fixture(); f.plan.eipDefinitions.push({...f.plan.eipDefinitions[0],key:'added',name:'Added'});
    const result=await f.build(), freshlyRendered=renderTencentRangeVariables({...f.rendering,tags:f.input.billingTags});
    expect(result.eips.find((entry:any)=>entry.key==='entry')?.creation_intent_id).toBe(f.prior.eips[0].creation_intent_id);
    expect(result.eips.find((entry:any)=>entry.key==='added')?.creation_intent_id).toBe(freshlyRendered.eips.find(entry=>entry.key==='added')?.creation_intent_id);
    expect(result.eips[0].creation_intent_id).not.toBe(result.eips[1].creation_intent_id);
  });
  it('uses fresh current-job network intents when a private range first enables NAT',async()=>{
    const f=fixture(); f.state.instances=f.state.instances.filter(resource=>resource.type==='tencentcloud_instance'); f.prior.nat_gateways=[]; f.prior.eips=[];
    const result=await f.build(), freshlyRendered=renderTencentRangeVariables({...f.rendering,tags:f.input.billingTags});
    expect(result.nat_gateways[0].creation_intent_id).toBe(freshlyRendered.nat_gateways[0].creation_intent_id);
    expect(result.eips[0].creation_intent_id).toBe(freshlyRendered.eips[0].creation_intent_id);
  });
  it.each(['missing_tag','conflicting_tag','conflicting_token','conflicting_name','foreign_native_id','missing_variables'] as const)('rejects %s before generating a new allocation intent for existing resources',async corruption=>{
    const f=fixture(), nat=f.state.instances[1],eip=f.state.instances[2];
    if(corruption==='missing_tag') delete (nat.attributes.tags as any).CreationIntentId;
    if(corruption==='conflicting_tag') (nat.attributes.tags as any).CreationIntentId='f'.repeat(32);
    if(corruption==='conflicting_token') eip.attributes.client_token='f'.repeat(32);
    if(corruption==='conflicting_name') nat.attributes.name='foreign-name';
    if(corruption==='foreign_native_id') f.input.knownResourceSummary.eipAllocationIds.entry='eip-foreign';
    if(corruption==='missing_variables') f.prior.nat_gateways=[];
    await expect(f.build()).rejects.toThrow('conflicts with frozen variables, state or platform inventory');
  });
});
