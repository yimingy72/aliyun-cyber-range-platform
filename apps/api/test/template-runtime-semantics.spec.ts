import { compileTemplateTopology, metadataFromTemplate } from '@aliyun-cyber-range/scenario-runtime/compiled';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { buildEnterpriseProvisionPlan } from '../src/provisioning/enterprise-provision-plan';
import { AlibabaCloudOpenTofuRenderer } from '../src/provisioning/renderers/alibaba-cloud-opentofu-renderer';
import { buildRootWrapperFiles } from '../src/provisioning/root-wrapper-template';

const metadata = {name:'Audit',slug:'audit',version:'v1',cloudProvider:'alibaba_cloud',iacType:'opentofu',modulePathOrRef:'infra/opentofu/modules/alicloud-enterprise-range'} as any;
function graph(): any {
  return {schemaVersion:'2.0.0', nodes:[
    {id:'r',kind:'router',label:'Router',routeRole:'egress',egressType:'internet',bindEip:false},
    {id:'s1',kind:'switch',label:'DMZ',zoneKey:'z1',cidr:'10.0.1.0/24',purpose:'dmz',aclRules:[],nat:{snatEnabled:true,dnatMappings:[{key:'http',targetHostId:'h',protocol:'tcp',externalPort:80,internalPort:80}]}},
    {id:'s2',kind:'switch',label:'Private',zoneKey:'z2',cidr:'10.0.2.0/24',purpose:'internal',aclRules:[],nat:{snatEnabled:false,dnatMappings:[]}},
    {id:'h',kind:'ecs',label:'Entry',instanceName:'Entry',hostName:'audit-host',zoneKey:'z1',role:'entry',privateIp:'10.0.1.10',image:'Test Image',imageName:'Test Image',imageId:'m-audit',platformImageAssetId:'asset-audit',cpu:2,memory:4,exposePublic:true,initScript:'',portGroups:[],dnatMappings:[],networkInterfaces:[],imageStrategy:{mode:'fixed',imageId:'m-audit'},instanceTypeStrategy:{mode:'auto'},nics:[
      {id:'n1',switchId:'s1',privateIp:'10.0.1.10',secondaryIps:['10.0.1.11'],securityGroupRulesMode:'custom',securityGroupRules:[{key:'sg-http',direction:'ingress',protocol:'tcp',portRange:'80/80',sourceCidr:'0.0.0.0/0',policy:'accept',priority:1}]},
      {id:'n2',switchId:'s2',privateIp:'10.0.2.10',secondaryIps:['10.0.2.11'],securityGroupRulesMode:'custom',securityGroupRules:[{key:'sg-ssh-private',direction:'ingress',protocol:'tcp',portRange:'22/22',sourceCidr:'10.0.2.0/24',policy:'accept',priority:1}]}
    ]}
  ],edges:[{id:'rs1',fromNodeId:'r',toNodeId:'s1',relationType:'manual'},{id:'rs2',fromNodeId:'r',toNodeId:'s2',relationType:'manual'},{id:'s1h',fromNodeId:'s1',toNodeId:'h',relationType:'manual'},{id:'s2h',fromNodeId:'s2',toNodeId:'h',relationType:'manual'}]};
}
function plan(payload: any): any {return buildEnterpriseProvisionPlan({rangeInstanceId:'audit',templateModulePath:metadata.modulePathOrRef,topologySpec:payload.topologySpec,compiledProvisionSpec:payload.compiledProvisionSpec,compiledSpec:payload.compiledSpec,allocatedCidr:null});}
function render(payload:any): any {return new AlibabaCloudOpenTofuRenderer().render({plan:plan(payload),rangeInstanceId:'audit',zoneId:'audit-zone',instanceType:'ecs.fake',hostInstanceTypes:{h:'ecs.fake'},imageId:'m-audit',hostPasswords:{},instancePassword:'test-only',allowedIngressCidr:'0.0.0.0/0',tags:{}});}
function repository(): any {return {getPlatformImageAssetById:async()=>({id:'asset-audit',imageId:'m-audit',enabled:true,visibility:'platform'}),createRangeTemplate:async(input:any)=>({id:'template-audit',revision:1,...input}),getPlatformUserById:async()=>null};}

describe('template runtime semantics',()=>{
  it('keeps Tencent identity on every host and derived network resource',()=>{
    const payload:any=compileTemplateTopology(graph(),{...metadata,cloudProvider:'tencent_cloud',modulePathOrRef:'infra/opentofu/modules/tencentcloud-enterprise-range'});
    expect(payload.scenarioTemplateSpec.metadata.cloudProvider).toBe('tencent_cloud');
    expect(payload.compiledProvisionSpec.identity.cloudProvider).toBe('tencent_cloud');
    expect(payload.compiledSpec.resources.every((resource:any)=>resource.provider==='tencent_cloud')).toBe(true);
    expect(payload.compiledSpec.resources.some((resource:any)=>resource.type==='nat_gateway')).toBe(true);
    expect(payload.compiledProvisionSpec.dnatEntries).toHaveLength(1);
    expect(payload.scenarioTemplateSpec.runtimePreferences.instanceTypePolicies[0].preferredInstanceTypes).toBeUndefined();
    expect(payload.scenarioTemplateSpec.runtimePreferences.instanceTypePolicies[0].mode).toBe('auto');
  });
  it('restores Tencent metadata without silently compiling it as Alibaba',()=>{
    expect(metadataFromTemplate({...metadata,cloudProvider:'tencent_cloud'}).cloudProvider).toBe('tencent_cloud');
    expect(()=>metadataFromTemplate({...metadata,cloudProvider:'unsupported'})).toThrow('Unsupported');
  });
  it('preserves primary and secondary NIC auxiliary IPs through rendering',()=>{
    const payload:any=compileTemplateTopology(graph(),metadata); const vars=render(payload);
    expect(payload.topologyGraph.nodes.find((n:any)=>n.id==='h').nics[0].secondaryIps).toEqual(['10.0.1.11']);
    expect(vars.host_network_interfaces[0].interfaces[0].secondary_private_ips).toEqual(['10.0.1.11']);
    expect(vars.host_network_interfaces[0].interfaces[1].secondary_private_ips).toEqual(['10.0.2.11']);
    expect(vars.host_network_interfaces[0].interfaces.map((nic:any)=>nic.nic_id)).toEqual(['n1','n2']);
  });
  it('targets each NIC rule to its own device index',()=>{
    const vars=render(compileTemplateTopology(graph(),metadata));
    expect(vars.security_group_rules).toHaveLength(2);
    expect(vars.security_group_rules.every((r:any)=>r.target_host_key==='h')).toBe(true);
    expect(vars.security_group_rules.map((r:any)=>r.target_device_index)).toEqual([0,1]);
  });
  it('assigns distinct stable DNAT keys to TCP and UDP at the same port',()=>{
    const g=graph();g.nodes[1].nat.dnatMappings.push({key:'http-udp',targetHostId:'h',protocol:'udp',externalPort:80,internalPort:80});
    const vars=render(compileTemplateTopology(g,metadata));
    expect(vars.dnat_entries.map((r:any)=>r.protocol)).toEqual(['tcp','udp']);
    expect(vars.dnat_entries.map((r:any)=>r.key)).toEqual(['dnat-h-tcp-80','dnat-h-udp-80']);
  });
  it('API rejects invalid graphs and executable firewall tampering before persistence',async()=>{
    const payload:any=compileTemplateTopology(graph(),metadata);
    payload.topologyGraph.nodes=payload.topologyGraph.nodes.filter((n:any)=>n.kind!=='router');payload.topologyGraph.edges=[];
    payload.compiledProvisionSpec.securityGroupRules[0].portRange='-1/-1';
    payload.compiledProvisionSpec.securityGroupRules[0].protocol='all';
    const repo=repository();repo.createRangeTemplate=jest.fn();
    const service=new RangeTemplatesService(repo);
    await expect(service.create({name:'Tampered',...payload},{id:'owner',role:'user'})).rejects.toThrow('Router');
    const firewall:any=compileTemplateTopology(graph(),metadata);
    firewall.compiledProvisionSpec.securityGroupRules[0].protocol='all';
    firewall.compiledProvisionSpec.securityGroupRules[0].portRange='-1/-1';
    await expect(service.create({name:metadata.name,...firewall},{id:'owner',role:'user'})).rejects.toThrow('compiledProvisionSpec does not match');
    expect(repo.createRangeTemplate).not.toHaveBeenCalled();
  });
  it('carries custom hostnames into renderer and root wrapper types',()=>{
    const payload:any=compileTemplateTopology(graph(),metadata);const vars=render(payload);
    expect(payload.topologyGraph.nodes.find((n:any)=>n.id==='h').hostName).toBe('audit-host');
    expect(vars.hosts[0].host_name).toBe('audit-host');
    const wrapper=buildRootWrapperFiles(metadata.modulePathOrRef);
    const hostDefinition=wrapper['variables.tf'].split('variable "hosts"')[1].split('variable "host_network_interfaces"')[0];
    expect(hostDefinition).toContain('host_name');
  });
  it.each(['sourceCidr','priority','policy','direction','protocol'])('rejects invalid ACL %s during detection',(field)=>{
    const g=graph();g.nodes[1].aclRules=[{key:'bad',direction:'inbound',protocol:'tcp',portRange:'80/80',sourceCidr:'invalid-cidr',policy:'typo',priority:999999}];
    const bad:any={key:'bad',direction:'inbound',protocol:'tcp',portRange:'80/80',sourceCidr:'0.0.0.0/0',policy:'allow',priority:1};
    bad[field]=field==='priority'?999999:'invalid';
    g.nodes[1].aclRules=[bad];
    expect(()=>compileTemplateTopology(g,metadata)).toThrow(/规则/);
  });
  it('creates isolated multi-ECS templates concurrently for separate users',async()=>{
    const g=graph();const second=structuredClone(g.nodes[3]);
    Object.assign(second,{id:'internal',label:'Internal',hostName:'internal-host',zoneKey:'z2',privateIp:'10.0.2.20',exposePublic:false,nics:[{id:'internal-nic',switchId:'s2',privateIp:'10.0.2.20',secondaryIps:[],securityGroupRules:[]}]});
    g.nodes.push(second);g.edges.push({id:'s2-internal',fromNodeId:'s2',toNodeId:'internal',relationType:'manual'});
    const repo=repository();repo.createRangeTemplate=jest.fn(async(input:any)=>({id:input.ownerUserId,revision:1,...input}));
    const service=new RangeTemplatesService(repo);
    const results=await Promise.all(['alice','bob'].map(id=>service.create({name:metadata.name,...compileTemplateTopology(g,metadata)} as any,{id,role:'user'})));
    expect(results.map(result=>result.ownerUserId)).toEqual(['alice','bob']);
    expect(results[0].topologySpec!.hosts).toHaveLength(2);
    expect(repo.createRangeTemplate).toHaveBeenCalledTimes(2);
  });
  it('preserves legacy host rules and NICs without new scoping fields',()=>{
    const payload:any=compileTemplateTopology(graph(),metadata);
    for(const rule of payload.compiledProvisionSpec.securityGroupRules)delete rule.targetDeviceIndex;
    for(const nic of payload.compiledProvisionSpec.hosts[0].networkInterfaces)delete nic.nicId;
    const vars=render(payload);
    expect(vars.security_group_rules.every((rule:any)=>rule.target_device_index===undefined)).toBe(true);
    expect(vars.host_network_interfaces[0].interfaces.every((nic:any)=>nic.nic_id===undefined)).toBe(true);
  });
});
