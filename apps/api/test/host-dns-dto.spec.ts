import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateRangeTemplateDto, SaveRangeTemplateTopologyDto } from '../src/admin/dto/range-template.dto';

const dns = { servers: ['10.0.10.10', '10.0.10.11'], nicIds: ['nic-secondary'], domain: 'lab.example' };
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
function payload() {
  return { name: 'Windows DNS DTO', expectedRevision: 1, topologySpec: { vpcCidr: '10.0.0.0/16', networkZones: [{key:'dmz',name:'DMZ',purpose:'dmz',cidr:'10.0.10.0/24',isPublicEntry:true}], hosts:[{key:'windows',name:'Windows',hostName:'member',zoneKey:'dmz',role:'entry',privateIp:'10.0.10.20',exposePublic:true,dns}], publicEntry:{hostKey:'windows',protocols:[{protocol:'rdp',port:3389}]}, executionPolicies:{} }, topologyGraph:{},scenarioTemplateSpec:{},compiledProvisionSpec:{},compiledSpec:{} };
}
const transform = (metatype: typeof CreateRangeTemplateDto | typeof SaveRangeTemplateTopologyDto, value: any) => {
  const body = structuredClone(value); if (metatype === CreateRangeTemplateDto) delete body.expectedRevision; else delete body.name;
  return pipe.transform(body, { type: 'body', metatype });
};
describe('DNS nested DTO through the production ValidationPipe',()=>{
 it.each([CreateRangeTemplateDto,SaveRangeTemplateTopologyDto])('accepts the complete compiled host and preserves ordered DNS in %s',async metatype=>{
  const value = await transform(metatype,payload()); expect(value.topologySpec.hosts[0]).toMatchObject({privateIp:'10.0.10.20',hostName:'member',exposePublic:true,dns});
 });
 it.each([null,{}, {...dns,typo:true},{...dns,servers:[]},{...dns,servers:['10.0.10.10','10.0.10.10']},{...dns,servers:['0.0.0.0']},{...dns,servers:['224.0.0.1']},{...dns,servers:['10.00.10.10']},{...dns,servers:['10.0.10.10;whoami']},{...dns,servers:['1.1.1.1','2.2.2.2','3.3.3.3','4.4.4.4','5.5.5.5']},{...dns,nicIds:[]},{...dns,nicIds:['nic-secondary','nic-secondary']},{...dns,nicIds:[null]},{...dns,nicIds:['bad\u0000nic']},{...dns,domain:null},{...dns,domain:''},{...dns,domain:'_ad.test'},{...dns,domain:'lab.example;whoami'}])('rejects invalid nested DNS without relaxing whitelist: %j',async invalid=>{
  const value=payload();(value.topologySpec.hosts[0] as any).dns=invalid; await expect(transform(CreateRangeTemplateDto,value)).rejects.toBeInstanceOf(BadRequestException); await expect(transform(SaveRangeTemplateTopologyDto,value)).rejects.toBeInstanceOf(BadRequestException);
 });
 it('keeps DNS absent for legacy automatic-DNS hosts',async()=>{const value=payload();delete (value.topologySpec.hosts[0] as any).dns;expect((await transform(CreateRangeTemplateDto,value)).topologySpec.hosts[0].dns).toBeUndefined();});
 it('rejects client-added host fields',async()=>{const value=payload();(value.topologySpec.hosts[0] as any).provider='tencent_cloud';await expect(transform(CreateRangeTemplateDto,value)).rejects.toBeInstanceOf(BadRequestException);});
});
