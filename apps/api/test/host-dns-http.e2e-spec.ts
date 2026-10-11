import * as workspaceScope from '../src/auth/cloud-workspace-scope';
import request from 'supertest';
import { compileTemplateTopology, type ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime/compiled';
import { collectRangeFixtureImage, createRangeApiFixture, futureExpiration, rangeTemplatePayload } from './support/range-api-fixture';

const dns = {servers:['10.0.10.10','10.0.10.11'],nicIds:['nic-secondary'],domain:'lab.example'};
describe('Windows dual-NIC DNS template HTTP contract',()=>{
 let fixture: Awaited<ReturnType<typeof createRangeApiFixture>>;
 let image: Awaited<ReturnType<typeof collectRangeFixtureImage>>;
 beforeAll(async()=>{jest.spyOn(workspaceScope,'requireCurrentCloudWorkspaceId').mockReturnValue('legacy-unbound');fixture=await createRangeApiFixture();image=await collectRangeFixtureImage(fixture.repository);await fixture.repository.upsertImageSnapshots({provider:'alibaba_cloud',accountUid:null,regionId:'cn-hangzhou',scope:'custom',snapshots:[{imageId:image.imageId,sourceImageName:image.displayName,status:'Available',isAvailable:true,osType:'windows',platform:'Windows Server 2019',lastSyncedAt:new Date()}]});});
 afterAll(async()=>{await fixture.app.close();});
 function payload(name='Windows dual NIC DNS') {
  const graph=rangeTemplatePayload(image,name,'10.0.0.0/16').topologyGraph as ScenarioGraphDraft;
  graph.nodes.push({id:'switch-internal',kind:'switch',label:'Internal',zoneKey:'internal',cidr:'10.0.20.0/24',purpose:'internal',aclRules:[],nat:{snatEnabled:false,dnatMappings:[]}});
  const host=graph.nodes.find(node=>node.kind==='ecs') as any;
  host.dns=dns; host.hostName='windows-member';host.nics.push({id:'nic-secondary',switchId:'switch-internal',privateIp:'10.0.20.10',secondaryIps:[],securityGroupRules:[]});
  graph.edges.push({id:'router-internal',fromNodeId:'router-main',toNodeId:'switch-internal',relationType:'manual'},{id:'internal-host',fromNodeId:'switch-internal',toNodeId:host.id,relationType:'manual'});
  return {name,...compileTemplateTopology(graph,{name,slug:'fixture',version:'v1',cloudProvider:'alibaba_cloud',iacType:'opentofu',modulePathOrRef:'infra/opentofu/modules/alicloud-enterprise-range'})} as any;
 }
 const post=(path:string,body:object)=>request(fixture.app.getHttpServer()).post(path).set('authorization',`Bearer ${fixture.adminToken}`).send(body);
 it('creates and detects/saves a complete dual-NIC DNS topology through the real whitelist pipeline',async()=>{
  const body=payload();const created=await post('/admin/scenarios',body).expect(201);
  expect(created.body.topologySpec.hosts[0]).toMatchObject({privateIp:'10.0.10.10',hostName:'windows-member',dns});
  const {name:_name,...topology}=body;
  const saved=await post(`/admin/scenarios/${created.body.id}/validate-and-save`,{...topology,expectedRevision:created.body.revision}).expect(200);
  expect(saved.body.topologySpec.hosts[0].dns).toEqual(dns);
  expect(saved.body.topologyGraph.nodes.find((node:any)=>node.kind==='ecs').nics).toHaveLength(2);
  const launched=await post('/admin/ranges/launch',{templateId:created.body.id,name:'DNS launch contract',expiresAt:futureExpiration()}).set('x-idempotency-key','dns-contract-launch').expect(201);
  const instance=await fixture.repository.getRangeInstanceById(launched.body.id);
  expect((instance!.runtimeTopologyGraph!.nodes as any[]).find(node=>node.kind==='ecs').dns).toEqual(dns);
  expect((instance!.runtimeTopologyGraph!.nodes as any[]).find(node=>node.kind==='ecs').nics).toHaveLength(2);
 });
 it('rejects foreign NIC selection before any template is persisted',async()=>{
  const body=payload('Foreign NIC');(body.topologyGraph.nodes.find((node:any)=>node.kind==='ecs') as any).dns={...dns,nicIds:['another-host-nic']};
  const response=await post('/admin/scenarios',body).expect(400);expect(String(response.body.message)).toContain('nicIds');
 });
 it('rejects unknown nested DNS fields through HTTP before persistence',async()=>{
  const body=payload('Unknown DNS property');(body.topologySpec.hosts[0] as any).dns={...dns,provider:'tencent_cloud'};
  const response=await post('/admin/scenarios',body).expect(400);expect(String(response.body.message)).toContain('property provider should not exist');
 });
});
