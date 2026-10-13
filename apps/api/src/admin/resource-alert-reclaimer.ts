import { Inject, Injectable } from '@nestjs/common';
import { ADMIN_REPOSITORY,type AdminRepository,type ProvisionJobRecord,type RangeInstanceRecord } from './admin.repository';
import { SystemConfigService,type SystemCloudAccountContext } from './system-config.service';
import { requireCurrentCloudWorkspaceId,getCurrentCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { ResourcePatrolCloudClient,type PatrolCloudResource } from './resource-patrol-cloud-client';
import { readPatrolInventories,patrolResourceIdentities,patrolResourceKey,type ProvenInventory } from './resource-patrol-inventory';
import type { ResourceIdentity,PatrolResourceType } from './resource-alert-types';
import { ResourcePatrolRepository } from './resource-patrol.repository';

type ConfirmedPlan={version:1;mode:'confirmed_inventory';cloudWorkspaceId:string;alertId:string;provider:'alibaba_cloud'|'tencent_cloud';
  accountUid:string;regionId:string;ownerUserId:string|null;executionContext:ProvenInventory['context'];resources:ResourceIdentity[];
  creationProofs:Record<string,string>;planDigest:string};
const supported=new Set<PatrolResourceType>(['ecs','disk','eip','nat_gateway','eni','vpc','vswitch','security_group','network_acl','route_table','snat_entry','dnat_entry']);
const inactive=new Set(['destroyed','create_failed','destroy_failed']);

/** Executes only an already confirmed physical inventory; no Terraform state or apply is consulted. */
@Injectable()
export class ResourceAlertReclaimer {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository:AdminRepository,private readonly config:SystemConfigService,
    private readonly cloud:ResourcePatrolCloudClient,private readonly alerts:ResourcePatrolRepository) {}
  static handles(job:ProvisionJobRecord) { return Boolean((job.topologySnapshot as any)?.resourceAlertPlan); }

  async execute(job:ProvisionJobRecord,instance:RangeInstanceRecord,assertClaim:()=>Promise<void>) {
    const plan=this.plan(job,instance),proof=await this.proof(plan,instance);
    const account=await this.config.getExecutionAccountContext({cloudAccountContextId:plan.executionContext.cloudAccountContextId});
    if (account.provider!==plan.provider||account.accountUid!==plan.accountUid||account.defaultRegion!==plan.regionId
      || account.cloudAccountContextId!==plan.executionContext.cloudAccountContextId) throw new Error('Confirmed cleanup frozen account differs from creation proof');
    await assertClaim();await this.cloud.verifyAccount(account);
    const recorded=proof.resources,confirmed=new Set(plan.resources.map(patrolResourceKey));
    const snapshot=async()=>{await assertClaim();await this.assertUnused(plan,instance,recorded);
      const rows=await this.cloud.inspect(account,recorded);this.validate(rows,proof,confirmed,instance);return rows;};
    let remaining=[...plan.resources];
    const deferredPrimary:ResourceIdentity[]=[];
    const main=await this.alerts.get(plan.alertId);
    if(!main||main.jobId!==job.id||main.accountUid!==plan.accountUid||main.regionId!==plan.regionId||main.rangeInstanceId!==instance.id
      || !proof.proven.has(`${main.type}:${main.resourceId}`)) throw new Error('Confirmed cleanup has no matching alert creation proof');
    try {
      const initial=await snapshot();
      for(const row of initial) if(row.type==='eni'&&row.isPrimary&&row.attachedInstanceId&&confirmed.has(`ecs:${row.attachedInstanceId}`)) {
        deferredPrimary.push({type:'eni',id:row.id});
      }
      const order:PatrolResourceType[]=plan.provider==='tencent_cloud'
        ? ['dnat_entry','snat_entry','eni','ecs','disk','nat_gateway','eip','security_group','network_acl','vswitch','route_table','vpc']
        : ['dnat_entry','snat_entry','eni','ecs','disk','eip','nat_gateway','security_group','network_acl','vswitch','route_table','vpc'];
      for (const type of order) {
      for (const resource of plan.resources.filter(row=>row.type===type)) {
        await assertClaim();await this.assertUnused(plan,instance,recorded);
        const rows=await this.cloud.exact(account,[resource],recorded);
        const current=rows.find(row=>patrolResourceKey(row)===patrolResourceKey(resource));
        if (!current) continue;
        this.validate([current],proof,confirmed,instance);
        if (['vpc','nat_gateway','security_group','network_acl','vswitch','route_table'].includes(type)) await snapshot();
        if (type==='disk') {
          // Both vendors require system disks to follow host deletion; independent disk APIs manage data disks only.
          try {await this.waitGone(account,resource,recorded,assertClaim);} catch {throw new Error('system_disk_still_present');}
          continue;
        }
        if (type==='eni'&&current.isPrimary) {deferredPrimary.push(resource);continue;}
        if(/terminating|deleting|releasing/i.test(String(current.raw.Status??current.raw.state??''))) {await this.waitGone(account,resource,recorded,assertClaim);continue;}
        if (type==='ecs') {
          const interfaces=await this.cloud.attachedInterfaces(account,current.id);
          if(!interfaces.some(nic=>nic.isPrimary)) throw new Error('Host primary interface relationship is unverified');
          for(const nic of interfaces) if(!nic.isPrimary
            && (!proof.proven.has(patrolResourceKey(nic))||!confirmed.has(patrolResourceKey(nic)))) throw new Error('Host has an unconfirmed attached secondary interface');
          const disks=await this.cloud.attachedDisks(account,current.id);
          if(!disks.some(disk=>disk.systemDisk)) throw new Error('Host system disk relationship is unverified');
          for(const disk of disks) if(!disk.systemDisk||!proof.proven.has(patrolResourceKey(disk))||!confirmed.has(patrolResourceKey(disk))
            || disk.attachedInstanceId!==current.id||!this.deleteWithHost(plan.provider,current,disk)) throw new Error('system_disk_lifecycle_unverified');
        }
        await this.remove(account,current,proof,confirmed,assertClaim,job);
        await this.waitGone(account,resource,recorded,assertClaim);
      }
      if(type==='ecs') for(const resource of deferredPrimary) await this.waitGone(account,resource,recorded,assertClaim);
      }
      // Independent cloud reads, rather than delete responses or an empty local state, establish absence.
      const final=await snapshot();
      if((await this.cloud.exact(account,deferredPrimary,recorded)).length) throw new Error('Owned host primary interface cascade is not complete');
      remaining=plan.resources.filter(resource=>final.some(row=>patrolResourceKey(row)===patrolResourceKey(resource)));
      if(remaining.length) throw new Error('Confirmed resources remain after native cleanup');
      await assertClaim();await this.closeLedgers(plan,instance,plan.resources,new Date());
      await this.log(job,'confirmed_inventory_absence',{cloudWorkspaceId:plan.cloudWorkspaceId,accountUid:plan.accountUid,
        regionId:plan.regionId,resources:plan.resources,verifiedAbsentAt:new Date().toISOString()});
      await assertClaim();await this.alerts.completeConfirmedCleanup(job.id,plan.accountUid,plan.regionId,new Date());
      return {verifiedAt:new Date(),resources:plan.resources};
    } catch(error) {
      await assertClaim();
      try {
        const check=[...new Map([...plan.resources,...deferredPrimary].map(resource=>[patrolResourceKey(resource),resource])).values()];
        const rows=await this.cloud.exact(account,check,recorded);
        remaining=check.filter(resource=>rows.some(row=>patrolResourceKey(row)===patrolResourceKey(resource)));
        await this.closeLedgers(plan,instance,plan.resources.filter(resource=>!remaining.some(row=>patrolResourceKey(row)===patrolResourceKey(resource))),new Date());
        if(!remaining.length) {
          await snapshot();
          await this.log(job,'confirmed_inventory_absence',{resources:plan.resources,verifiedAbsentAt:new Date().toISOString(),recoveredUnknownResponse:true});
          await assertClaim();await this.alerts.completeConfirmedCleanup(job.id,plan.accountUid,plan.regionId,new Date());
          return {verifiedAt:new Date(),resources:plan.resources};
        }
      } catch { /* Failed reads retain the entire previous remaining list. */ }
      const systemDiskFailure=error instanceof Error && ['system_disk_still_present','system_disk_lifecycle_unverified'].includes(error.message)
        ? error.message as 'system_disk_still_present'|'system_disk_lifecycle_unverified' : undefined;
      await this.log(job,'confirmed_inventory_remaining',{resources:remaining,reason:systemDiskFailure??'native_cleanup_failed_or_unverified'});
      await assertClaim();await this.alerts.failConfirmedCleanup(job.id,plan.accountUid,plan.regionId,remaining,systemDiskFailure);
      throw new Error('Confirmed inventory cleanup failed or is unverified; accurate remaining inventory was preserved');
    }
  }

  private plan(job:ProvisionJobRecord,instance:RangeInstanceRecord):ConfirmedPlan {
    const value=(job.topologySnapshot as any)?.resourceAlertPlan as ConfirmedPlan;
    const scope=getCurrentCloudWorkspaceScope();
    if(job.jobType!=='destroy'||!job.startedAt||!job.triggeredBy.startsWith('resource-alert:')||job.rangeInstanceId!==instance.id||job.cloudWorkspaceId!==instance.cloudWorkspaceId
      || !value||value.version!==1||value.mode!=='confirmed_inventory'||value.cloudWorkspaceId!==requireCurrentCloudWorkspaceId()
      || !scope||'system' in scope||scope.provider!==value.provider||scope.accountUid!==value.accountUid
      || value.provider!==instance.cloudProvider||value.ownerUserId!==instance.ownerUserId||!value.executionContext
      || value.executionContext.provider!==value.provider||value.executionContext.cloudAccountUid!==value.accountUid
      || value.executionContext.regionId!==value.regionId||!value.executionContext.cloudAccountContextId
      || typeof value.alertId!=='string'||!value.alertId||!Array.isArray(value.resources)||!value.resources.length||value.resources.length>10000||!value.creationProofs
      || !/^[a-f0-9]{64}$/.test(value.planDigest)||value.resources.some(row=>!row||!supported.has(row.type)||typeof row.id!=='string'||!row.id||row.id.length>256)
      || new Set(value.resources.map(patrolResourceKey)).size!==value.resources.length) throw new Error('Confirmed cleanup has no matching immutable physical plan');
    return value;
  }
  private async proof(plan:ConfirmedPlan,instance:RangeInstanceRecord) {
    const [instances,jobs]=await Promise.all([this.repository.listRangeInstances(),this.repository.listProvisionJobs()]);
    const data=await readPatrolInventories(this.repository,instances,jobs,{cloudWorkspaceId:plan.cloudWorkspaceId,provider:plan.provider,accountUid:plan.accountUid});
    const found=data.filter(row=>row.instance.id===instance.id&&row.context.cloudAccountContextId===plan.executionContext.cloudAccountContextId
      && row.context.regionId===plan.regionId&&row.context.zoneId===plan.executionContext.zoneId);
    if(found.length!==1||plan.resources.some(resource=>!found[0].proven.has(patrolResourceKey(resource))
      || found[0].birthSources.get(patrolResourceKey(resource))!==plan.creationProofs[patrolResourceKey(resource)])) throw new Error('Confirmed cleanup original creation inventory is incomplete');
    return found[0];
  }
  private async assertUnused(plan:ConfirmedPlan,instance:RangeInstanceRecord,resources:ResourceIdentity[]) {
    const keys=new Set(resources.map(patrolResourceKey));
    const [instances,jobs,profiles]=await Promise.all([this.repository.listRangeInstances(),this.repository.listProvisionJobs(),this.repository.listSingleInstanceNetworkProfiles()]);
    for(const other of instances) if(other.id!==instance.id&&(!inactive.has(other.status)||jobs.some(job=>job.rangeInstanceId===other.id&&['pending','running'].includes(job.status)))) {
      if(patrolResourceIdentities(other.resourceSummary).some(row=>keys.has(patrolResourceKey(row)))
        || other.singleInstanceConfig?.assignedVswitchId&&keys.has(`vswitch:${other.singleInstanceConfig.assignedVswitchId}`)) throw new Error('Confirmed cleanup resources have an active platform reference');
    }
    if(profiles.some(profile=>profile.cloudAccountUid===plan.accountUid&&profile.regionId===plan.regionId
      && [profile.vpcId,profile.securityGroupId,...profile.vswitchIds].some(id=>resources.some(row=>row.id===id)))) throw new Error('Shared network pools cannot be reclaimed as instance residuals');
  }
  private validate(rows:PatrolCloudResource[],proof:ProvenInventory,confirmed:Set<string>,instance:RangeInstanceRecord) {
    const parentIds=new Set(proof.resources.filter(row=>['ecs','nat_gateway','vpc','eni'].includes(row.type)).map(row=>row.id));
    for(const row of rows) {
      const key=patrolResourceKey(row),owned=proof.proven.has(key);
      const primary=row.type==='eni'&&row.isPrimary&&row.attachedInstanceId&&proof.proven.has(`ecs:${row.attachedInstanceId}`);
      if(!owned) {if(row.parentId&&parentIds.has(row.parentId)&&!primary) throw new Error('Owned parent contains an unconfirmed cloud dependant');continue;}
      if(!confirmed.has(key)) throw new Error('Cloud inventory changed beyond the confirmed physical plan');
      if(row.attachedInstanceId&&!parentIds.has(row.attachedInstanceId)||row.raw.shared===true||row.raw.IsShared===true) throw new Error('Confirmed resource is occupied by a foreign or shared cloud resource');
      const tags=row.tags;
      for(const [name,value] of Object.entries({CloudAccountUid:proof.context.cloudAccountUid,CloudAccountContextId:proof.context.cloudAccountContextId,
        RangeInstanceId:instance.id,PlatformScope:instance.ownerUserId?'user':'platform',...(instance.ownerUserId?{PlatformUserId:instance.ownerUserId}:{})})) {
        if(tags[name]!==undefined&&tags[name]!==value) throw new Error('Native resource conflicts with its frozen creation identity');
      }
      if(!instance.ownerUserId&&tags.PlatformUserId || tags.PlatformCreateJobId&&!proof.sourceJobIds.includes(tags.PlatformCreateJobId)) throw new Error('Native resource creation source conflicts with original inventory');
      if(row.type==='disk'&&!row.systemDisk) throw new Error('Confirmed system disk changed usage type');
      const linkedInterface=row.raw.networkInterfaceId??row.raw.NetworkInterfaceId;
      if(row.type==='eip'&&typeof linkedInterface==='string'&&linkedInterface&&!parentIds.has(linkedInterface)
        && !row.attachedInstanceId) throw new Error('Confirmed address is attached to a foreign interface');
      if(row.type==='nat_gateway') {
        const eipIds=Array.isArray(row.raw.relatedEipIds)?row.raw.relatedEipIds:(row.raw.IpLists as any)?.IpList?.map((item:any)=>item.AllocationId)??[];
        if(eipIds.some((id:string)=>!proof.proven.has(`eip:${id}`)||!confirmed.has(`eip:${id}`))) throw new Error('Confirmed NAT has an unconfirmed address association');
      }
      if(row.type==='snat_entry') {
        const subnet=row.raw.SourceVSwitchId??row.raw.ResourceId;
        if(typeof subnet==='string'&&!proof.proven.has(`vswitch:${subnet}`)||row.raw.ResourceType!==undefined&&row.raw.ResourceType!=='SUBNET') throw new Error('SNAT source is outside original owned subnets');
      }
      if(row.type==='dnat_entry') {
        const target=row.raw.InternalIp??row.raw.PrivateIpAddress;
        const hosts=((instance.runtimeTopologyGraph as any)?.nodes??[]).filter((node:any)=>node.kind==='ecs');
        const ips=new Set<string>(hosts.flatMap((node:any)=>[node.privateIp,...(node.nics??[]).map((nic:any)=>nic.privateIp)]).filter((ip:any)=>typeof ip==='string'));
        for(const node of rows.filter(value=>value.type==='ecs'&&proof.proven.has(patrolResourceKey(value)))) {
          const raw=node.raw as any;for(const ip of [...(raw.VpcAttributes?.PrivateIpAddress?.IpAddress??[]),raw.detail?.privateIp]) if(typeof ip==='string')ips.add(ip);
        }
        if(typeof target==='string'&&ips.size&&!ips.has(target)) throw new Error('DNAT target is outside original owned host addresses');
      }
    }
  }

  private deleteWithHost(provider:ConfirmedPlan['provider'],host:PatrolCloudResource,disk:PatrolCloudResource) {
    const flag=disk.raw.DeleteWithInstance??disk.raw.deleteWithInstance;
    if(flag===false) return false;
    if(provider==='alibaba_cloud') return flag===true;
    // Tencent system-disk lifecycle is mandatory; generic CBS attributes may omit DeleteWithInstance.
    return disk.raw.diskUsage==='SYSTEM_DISK' && (host.raw.detail as any)?.systemDiskId===disk.id;
  }
  private async remove(account:SystemCloudAccountContext,row:PatrolCloudResource,proof:ProvenInventory,confirmed:Set<string>,assertClaim:()=>Promise<void>,job:ProvisionJobRecord) {
    const write=async(service:'ecs'|'cvm'|'vpc',action:string,parameters:Record<string,unknown>)=>{
      await assertClaim();await this.log(job,'confirmed_inventory_delete_intent',{resource:{type:row.type,id:row.id},action,regionId:account.defaultRegion,accountUid:account.accountUid});
      await assertClaim();const response=await this.cloud.mutate(account,service,action,parameters);
      if(typeof response.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(response.requestId)
        || [account.accessKeyId,account.accessKeySecret].some(secret=>secret&&response.requestId.includes(secret))) throw new Error('UNKNOWN_RECLAIM_RESPONSE');
      await this.log(job,'confirmed_inventory_delete_receipt',{resource:{type:row.type,id:row.id},action,requestId:response.requestId});return response;
    };
    const tencent=account.provider==='tencent_cloud';
    if(row.type==='eni'&&row.attachedInstanceId) {
      await write(tencent?'vpc':'ecs','DetachNetworkInterface',{NetworkInterfaceId:row.id,InstanceId:row.attachedInstanceId});
      await this.waitDetached(account,row,proof.resources,assertClaim);
    }
    if(row.type==='eip'&&row.attachedInstanceId) {
      if(tencent) await write('vpc','DisassociateAddress',{AddressId:row.id});
      else await write('vpc','UnassociateEipAddress',{AllocationId:row.id,InstanceId:row.attachedInstanceId,
        InstanceType:typeof row.raw.InstanceType==='string'?row.raw.InstanceType:'Nat'});
      await this.waitDetached(account,row,proof.resources,assertClaim);
    }
    if(row.type==='network_acl') {
      const ids:string[]=tencent?(row.raw.relatedSubnetIds as string[]??[]):((row.raw.Resources as any)?.Resource??[]).map((item:any)=>item.ResourceId);
      if(ids.some(id=>!confirmed.has(`vswitch:${id}`))) throw new Error('Network ACL has an unconfirmed subnet association');
      if(ids.length) await write('vpc',tencent?'DisassociateNetworkAclSubnets':'UnassociateNetworkAcl',tencent?{NetworkAclId:row.id,SubnetIds:ids}
        :{NetworkAclId:row.id,...Object.fromEntries(ids.flatMap((id,index)=>[[`Resource.${index+1}.ResourceId`,id],[`Resource.${index+1}.ResourceType`,'VSwitch']]))});
    }
    if(row.type==='ecs') {await write(tencent?'cvm':'ecs',tencent?'TerminateInstances':'DeleteInstances',tencent
      ?{InstanceIds:[row.id],ReleaseAddress:false,ReleasePrepaidDataDisks:false}:{'InstanceId.1':row.id,Force:true});return;}
    if(row.type==='snat_entry'||row.type==='dnat_entry') {
      if(!row.parentId||!proof.proven.has(`nat_gateway:${row.parentId}`)) throw new Error('Rule lacks a proven parent gateway');
      if(tencent) await write('vpc',row.type==='snat_entry'?'DeleteNatGatewaySourceIpTranslationNatRule':'DeleteNatGatewayDestinationIpPortTranslationNatRule',row.type==='snat_entry'
        ?{NatGatewayId:row.parentId,NatGatewaySnatIds:[row.raw.NatGatewaySnatId]}
        :{NatGatewayId:row.parentId,DestinationIpPortTranslationNatRules:[{IpProtocol:row.raw.IpProtocol,PublicIpAddress:row.raw.PublicIpAddress,
          PublicPort:row.raw.PublicPort,PrivateIpAddress:row.raw.PrivateIpAddress,PrivatePort:row.raw.PrivatePort}]});
      else {const [table,id]=row.id.split(':');if(!table||!id) throw new Error('Rule has no exact provider table identity');
        await write('vpc',row.type==='snat_entry'?'DeleteSnatEntry':'DeleteForwardEntry',row.type==='snat_entry'?{SnatTableId:table,SnatEntryId:id}:{ForwardTableId:table,ForwardEntryId:id});}
      return;
    }
    const api:Partial<Record<PatrolResourceType,[string,string]>>={eni:['DeleteNetworkInterface','NetworkInterfaceId'],eip:[tencent?'ReleaseAddresses':'ReleaseEipAddress',tencent?'AddressIds':'AllocationId'],
      nat_gateway:['DeleteNatGateway','NatGatewayId'],security_group:['DeleteSecurityGroup','SecurityGroupId'],network_acl:['DeleteNetworkAcl','NetworkAclId'],
      vswitch:[tencent?'DeleteSubnet':'DeleteVSwitch',tencent?'SubnetId':'VSwitchId'],route_table:['DeleteRouteTable','RouteTableId'],vpc:['DeleteVpc','VpcId']};
    const [action,idKey]=api[row.type]??[];
    if(!action||!idKey) throw new Error('Unsupported confirmed native cleanup type');
    await write(tencent||!['eni','security_group'].includes(row.type)?'vpc':'ecs',action,{[idKey]:tencent&&row.type==='eip'?[row.id]:row.id});
  }
  private async waitGone(account:SystemCloudAccountContext,resource:ResourceIdentity,parents:ResourceIdentity[],assertClaim:()=>Promise<void>) {
    let empty=0;
    for(let attempt=0;attempt<12;attempt++){await assertClaim();empty=(await this.cloud.exact(account,[resource],parents)).length?0:empty+1;if(empty>=2)return;await this.pause();}
    throw new Error('Native deletion has no verified absence yet');
  }
  private async waitDetached(account:SystemCloudAccountContext,resource:ResourceIdentity,parents:ResourceIdentity[],assertClaim:()=>Promise<void>) {
    for(let attempt=0;attempt<12;attempt++){await assertClaim();const rows=await this.cloud.exact(account,[resource],parents);if(!rows.length||!rows[0].attachedInstanceId)return;await this.pause();}
    throw new Error('Native detach has no verified completion yet');
  }
  private pause(){return new Promise<void>(resolve=>setTimeout(resolve,2000));}
  private async closeLedgers(plan:ConfirmedPlan,instance:RangeInstanceRecord,resources:ResourceIdentity[],verifiedAt:Date) {
    const keys=new Set(resources.map(patrolResourceKey));
    for(const ledger of await this.repository.listBillingLedgerResources({rangeInstanceId:instance.id})) if(!ledger.releasedAt&&keys.has(`${ledger.cloudResourceType}:${ledger.cloudResourceId}`)) {
      if(ledger.cloudProvider!==plan.provider||ledger.cloudAccountUid!==plan.accountUid||ledger.regionId!==plan.regionId||ledger.ownerUserId!==instance.ownerUserId) throw new Error('Cleanup billing release has an ownership conflict');
      await this.repository.updateBillingLedgerResource(ledger.id,{releasedAt:verifiedAt});
    }
  }
  private log(job:ProvisionJobRecord,stepName:string,value:Record<string,unknown>){const now=new Date();return this.repository.createProvisionJobStepLog({jobId:job.id,stepName,status:'succeeded',
    message:JSON.stringify(value),startedAt:now,finishedAt:now,stdoutExcerpt:null,stderrExcerpt:null});}
}
