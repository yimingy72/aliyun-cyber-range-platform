import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenTofuRangeProvisioner, preserveDeployedRangeUserData } from '../src/provisioning/open-tofu-range-provisioner';
import type { RangeProvisionCreateInput } from '../src/provisioning/provisioning.types';
import type { WorkspaceState } from '../src/provisioning/opentofu-state-evidence';

function fixture(provider: 'alibaba_cloud'|'tencent_cloud') {
 const tencent=provider==='tencent_cloud';const region=tencent?'ap-nanjing':'cn-hangzhou';const zone=region+'-1';
 const account={provider,accountUid:'account-owned',cloudAccountContextId:'context-owned',defaultRegion:region,defaultZoneId:zone,accessKeyId:'fixture',accessKeySecret:'fixture'};
 const tags={CloudProvider:provider,CloudAccountUid:account.accountUid,CloudAccountContextId:account.cloudAccountContextId,RangeInstanceId:'range-owned',CreatedBy:'cyber-range-platform',PlatformScope:'user',PlatformUserId:'owner'};
 const input:RangeProvisionCreateInput={rangeInstanceId:'range-owned',instanceMode:'range',templateModulePath:'infra/module',allocatedCidr:null,runtimeConfig:account,billingTags:tags,preserveWorkspaceState:true,requirePersistedState:true};
 const state:WorkspaceState={lineage:'owned-lineage',serial:1,instances:[{type:tencent?'tencentcloud_instance':'alicloud_instance',module:'module.range',address:`module.range.${tencent?'tencentcloud_instance':'alicloud_instance'}.hosts["existing"]`,tainted:false,attributes:{id:tencent?'ins-owned':'i-owned',tags,availability_zone:zone}}]};
 const scripts=[{key:'first',name:'First',type:'powershell',content:'[powershell]\r\nWrite-Output "original"\r\n',target_host_keys:['existing']},{key:'second',name:'Second',type:'powershell',content:'Write-Output "literal $ and \\path"',target_host_keys:['existing']}];
 const prior={tags,region,zone_id:zone,hosts:[{key:'existing',user_data:'<powershell>\r\n original \r\n</powershell>'}],bootstrap_scripts:scripts};
 const next={tags,region,zone_id:zone,hosts:[{key:'existing',image_id:'wanted-new-image',user_data:'new generated payload'},{key:'added',user_data:'new host payload'}],bootstrap_scripts:[{key:'first',name:'First',type:'powershell',content:'platform generator v2',target_host_keys:['existing','added']}],network_interfaces:[{key:'new-nic'}]};
 return {input,state,prior,next};
}
describe('live range host startup bytes stay frozen across script generator releases',()=>{
 it.each(['alibaba_cloud','tencent_cloud'] as const)('preserves %s existing host startup bytes and keeps new host/image/NIC changes',provider=>{
  const t=fixture(provider);const result=preserveDeployedRangeUserData(t.input,t.state,t.prior,t.next);
  expect(result.hosts.map(host=>host.key)).toEqual(['existing','added']);expect(result.hosts[0].image_id).toBe('wanted-new-image');expect(result.network_interfaces).toEqual([{key:'new-nic'}]);
  if(provider==='tencent_cloud'){expect(result.hosts[0].user_data).toBe(t.prior.hosts[0].user_data);expect(result.hosts[1].user_data).toBe('new host payload');}
  else {expect(result.bootstrap_scripts.filter(script=>script.target_host_keys.includes('existing')).map(script=>script.content).join('\n\n')).toBe(t.prior.bootstrap_scripts.map(script=>script.content).join('\n\n'));expect(result.bootstrap_scripts.filter(script=>script.target_host_keys.includes('added')).map(script=>script.content)).toEqual(['platform generator v2']);}
 });
 it.each(['alibaba_cloud','tencent_cloud'] as const)('does not resurrect a deliberately deleted %s host',provider=>{const t=fixture(provider);t.next.hosts=t.next.hosts.filter(host=>host.key!=='existing');t.next.bootstrap_scripts[0].target_host_keys=['added'];const result=preserveDeployedRangeUserData(t.input,t.state,t.prior,t.next);expect(result.hosts.map(host=>host.key)).toEqual(['added']);expect(result.bootstrap_scripts.every(script=>!script.target_host_keys.includes('existing'))).toBe(true);});
 it.each(['alibaba_cloud','tencent_cloud'] as const)('keeps empty %s startup data empty',provider=>{const t=fixture(provider);t.prior.hosts[0].user_data='';t.prior.bootstrap_scripts=[];const result=preserveDeployedRangeUserData(t.input,t.state,t.prior,t.next);if(provider==='tencent_cloud')expect(result.hosts[0].user_data).toBe('');else expect(result.bootstrap_scripts.every(script=>!script.target_host_keys.includes('existing'))).toBe(true);});
 it.each(['alibaba_cloud','tencent_cloud'] as const)('fails closed on missing %s original variables',provider=>{const t=fixture(provider);expect(()=>preserveDeployedRangeUserData(t.input,t.state,null,t.next)).toThrow('cannot be verified');});
 it.each(['alibaba_cloud','tencent_cloud'] as const)('fails closed on missing %s host data',provider=>{const t=fixture(provider);if(provider==='tencent_cloud')delete (t.prior.hosts[0] as any).user_data;else delete (t.prior as any).bootstrap_scripts;expect(()=>preserveDeployedRangeUserData(t.input,t.state,t.prior,t.next)).toThrow('cannot be verified');});
 it.each(['alibaba_cloud','tencent_cloud'] as const)('rejects foreign %s account/host/state without changing variables',provider=>{const mutations=[(t:any)=>t.prior.tags={...t.prior.tags,CloudAccountUid:'foreign'},(t:any)=>t.state.instances[0].attributes.tags={...t.prior.tags,CloudAccountContextId:'foreign'},(t:any)=>t.state.instances[0].tainted=true,(t:any)=>t.state.instances.push({...t.state.instances[0]}),(t:any)=>t.state.instances[0].attributes.availability_zone='foreign-zone',(t:any)=>t.prior.hosts=[]];for(const mutate of mutations){const t=fixture(provider);mutate(t);const before=structuredClone(t.next);expect(()=>preserveDeployedRangeUserData(t.input,t.state,t.prior,t.next)).toThrow('cannot be verified');expect(t.next).toEqual(before);}});
 it('does not freeze brand-new ranges or single-instance workspaces',()=>{const t=fixture('alibaba_cloud');t.state.instances=[];expect(preserveDeployedRangeUserData(t.input,t.state,null,t.next)).toBe(t.next);});
 it.each(['alibaba_cloud','tencent_cloud'] as const)('retains %s original tfvars on preparation failure before any provider command',async provider=>{
  const t=fixture(provider);const root=await fs.mkdtemp(path.join(os.tmpdir(),'range-userdata-freeze-'));const dir=path.join(root,t.input.rangeInstanceId);await fs.mkdir(dir,{recursive:true});await fs.mkdir(path.join(root,'infra/module'),{recursive:true});
  await fs.writeFile(path.join(dir,'terraform.tfstate'),JSON.stringify({version:4,lineage:t.state.lineage,serial:1,resources:[{module:'module.range',mode:'managed',type:t.state.instances[0].type,name:'hosts',instances:[{index_key:'existing',attributes:t.state.instances[0].attributes}]}]}));
  const original=JSON.stringify({...t.prior,tags:{...t.prior.tags,CloudAccountUid:'foreign'}});await fs.writeFile(path.join(dir,'range.auto.tfvars.json'),original);
  const provisioner=new OpenTofuRangeProvisioner({projectRootDir:root,workspacesRootDir:root,runner:{} as any});jest.spyOn(provisioner as any,'buildVariables').mockResolvedValue(t.next);jest.spyOn(provisioner as any,'buildRunnerEnv').mockResolvedValue({});
  if(provider==='tencent_cloud'){t.input.templateModulePath='infra/opentofu/modules/tencentcloud-enterprise-range';await fs.mkdir(path.join(root,t.input.templateModulePath),{recursive:true});await fs.writeFile(path.join(dir,'tencent-range-identity.json'),JSON.stringify({provider,cloudAccountContextId:t.input.runtimeConfig!.cloudAccountContextId,cloudAccountUid:t.input.runtimeConfig!.accountUid,regionId:t.input.runtimeConfig!.defaultRegion,zoneId:t.input.runtimeConfig!.defaultZoneId,rangeInstanceId:t.input.rangeInstanceId}));}
  try{await expect((provisioner as any).prepareWorkspace(t.input,{preserveWorkspaceState:true,requireRuntimePasswords:true})).rejects.toThrow('cannot be verified');expect(await fs.readFile(path.join(dir,'range.auto.tfvars.json'),'utf8')).toBe(original);}finally{await fs.rm(root,{recursive:true,force:true});}
 });
});
