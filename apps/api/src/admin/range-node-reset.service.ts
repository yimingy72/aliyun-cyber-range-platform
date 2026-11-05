import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ADMIN_REPOSITORY, type AdminRepository, type ProvisionJobRecord, type RangeInstanceRecord } from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { requireCurrentCloudWorkspaceId } from '../auth/cloud-workspace-scope';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';
import { readPatrolInventories } from './resource-patrol-inventory';
import { RangeNodeResetCloudClient, NodeResetCloudError, type ResetCloudRow } from './range-node-reset-cloud.client';
import { RangeDnsVerificationService } from './range-dns-verification.service';
import { assertPowerAllowsMutation } from './instance-power-types';

type Actor = Pick<SessionUserProfile,'id'|'role'>;
export type RangeNodeResetTarget = {
  version:1; cloudWorkspaceId:string; ownerUserId:string|null; nodeId:string; nodeName:string; instanceId:string; systemDiskId:string; imageId:string;
  sourceJobId:string; tagJobId:string; cloudAccountContextId:string; accountUid:string; regionId:string; originalPowerState:'Running'|'Stopped';
  dataDiskIds:string[]; networkDigest:string; autoReleaseTime:string|null; expiresAt:string|null; hasDns:boolean;
};
export type RangeNodeResetPreview = RangeNodeResetTarget & {rangeInstanceId:string;planDigest:string;destructive:true};
export type RangeNodeResetInput = {planDigest:string;confirmedNodeName:string};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted=(values:string[])=>[...values].sort();
const iso=(value:unknown)=>value===undefined||value===null||value===''?null:
  typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():(()=>{throw new Error('RESET_INVALID_DEADLINE');})();
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

@Injectable()
export class RangeNodeResetService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository:AdminRepository,
    private readonly config:SystemConfigService,private readonly cloud:RangeNodeResetCloudClient,
    private readonly dns:RangeDnsVerificationService) {}

  async assertAccess(rangeId:string,nodeId:string,user:Actor) {
    const instance=await this.repository.getRangeInstanceById(rangeId);
    if(!instance) throw new NotFoundException('编排实例不存在。');
    if(user.role!=='admin'&&instance.ownerUserId!==user.id) throw new ForbiddenException('无权重置该实例。');
    if(instance.instanceMode!=='range'||instance.cloudProvider!=='alibaba_cloud'||instance.resourceSummary?.mode!=='opentofu')
      throw new ConflictException('系统盘重置目前仅支持阿里云编排实例。');
    const node=this.node(instance,nodeId);
    if(!node) throw new NotFoundException('已部署的 ECS 节点不存在。');
    return {instance,node};
  }
  async preview(rangeId:string,nodeId:string,user:Actor):Promise<RangeNodeResetPreview> {
    const {instance}=await this.assertAccess(rangeId,nodeId,user);
    return (await this.checkedPrepare(instance,nodeId)).preview;
  }
  async enqueue(rangeId:string,nodeId:string,input:RangeNodeResetInput,user:Actor) {
    this.validateInput(input);
    const {instance}=await this.assertAccess(rangeId,nodeId,user);
    const {preview}=await this.checkedPrepare(instance,nodeId);
    if(input.planDigest!==preview.planDigest||input.confirmedNodeName!==preview.nodeName)
      throw new ConflictException('节点、磁盘或电源状态已变化，或确认名称不符；请重新核验并确认。');
    const {rangeInstanceId,planDigest,destructive,...target}=preview;
    const job=await this.repository.queueRangeInstanceJob({rangeInstanceId:instance.id,jobType:'reset',triggeredBy:user.id,
      expectedStatus:'running',expectedOwnerUserId:instance.ownerUserId,expectedUpdatedAt:instance.updatedAt,nextStatus:'running',
      topologySnapshot:{draftRevision:0,topologyGraph:{},topologySpec:{},scenarioTemplateSpec:{},compiledProvisionSpec:{},compiledSpec:{},
        templateModulePath:'',operation:'reset',nodeReset:target}});
    if(!job) throw new ConflictException('实例已有活动任务或来源已变化，未执行重置。');
    return {status:'accepted' as const,action:'reset' as const,jobId:job.id,nodeId};
  }
  private async checkedPrepare(instance:RangeInstanceRecord,nodeId:string) {
    try { return await this.prepare(instance,nodeId); }
    catch(error) {
      if(error instanceof ConflictException) throw error;
      throw new ConflictException(`重置前核验未通过，未执行磁盘恢复。${this.failure(error,false)}`);
    }
  }
  validateInput(value:unknown):asserts value is RangeNodeResetInput {
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['planDigest','confirmedNodeName'].includes(key))
      ||typeof (value as any).planDigest!=='string'||!/^[a-f0-9]{64}$/.test((value as any).planDigest)
      ||typeof (value as any).confirmedNodeName!=='string'||!(value as any).confirmedNodeName.trim()||(value as any).confirmedNodeName.length>256)
      throw new BadRequestException('重置必须提供核验摘要及准确节点名称，不接受云资源 ID、密码或脚本。');
  }
  async execute(job:ProvisionJobRecord,assertClaim:()=>Promise<void>) {
    const target=job.topologySnapshot?.nodeReset;
    if(job.jobType!=='reset'||job.topologySnapshot?.operation!=='reset'||!target||target.version!==1) throw new Error('RESET_SNAPSHOT_MISSING');
    const steps=await this.repository.listProvisionJobStepLogs(job.id);
    const intended=steps.some(step=>step.stepName==='node_reset_reinit_intent');
    const received=steps.some(step=>step.stepName==='node_reset_reinit_receipt'&&step.status==='succeeded');
    if(intended&&!received) throw new ConflictException('上次磁盘重置结果未知，禁止自动重发；请核验原任务后处理。');
    const instance=await this.current(job,target,assertClaim);
    const account=await this.account(instance,target);
    await this.cloud.verifyAccount(account);
    let reinitIntent=intended;
    let diskReady=false;
    try {
      await this.checkCloud(instance,target,account,received);
      if(!received) {
        const host=await this.cloud.host(account,target.instanceId);
        if(!steps.some(step=>step.stepName==='node_reset_stop')&&host.Status!==target.originalPowerState) throw new Error('RESET_POWER_STATE_CHANGED');
        if(host.Status!=='Stopped') {
          if(host.Status!=='Running'&&host.Status!=='Stopping') throw new Error('RESET_POWER_STATE_CHANGED');
          if(host.Status==='Running') {
            await this.current(job,target,assertClaim);
            await this.step(job,'node_reset_stop','started','正在正常关机，保留计费与网络资源。');
            const receipt=await this.cloud.stop(account,target.instanceId);
            await this.step(job,'node_reset_stop','succeeded',JSON.stringify(receipt));
          }
          await this.waitFor(job,target,account,assertClaim,async()=> (await this.cloud.host(account,target.instanceId)).Status==='Stopped');
        }
        await this.current(job,target,assertClaim);
        await this.checkCloud(instance,target,account,false);
        if((await this.cloud.host(account,target.instanceId)).Status!=='Stopped') throw new Error('RESET_HOST_NOT_STOPPED');
        await this.step(job,'node_reset_reinit_intent','succeeded','已持久记录唯一系统盘恢复意图；未知结果不得自动重发。');
        reinitIntent=true;
        let receipt:{requestId:string};
        try { receipt=await this.cloud.reinitialize(account,target.systemDiskId,this.password(instance,target.nodeId)); }
        catch(error) {
          if(error instanceof NodeResetCloudError&&error.rejected) await this.step(job,'node_reset_reinit_rejected','failed',JSON.stringify({code:error.code,requestId:error.requestId,rejected:true}));
          throw error;
        }
        await this.step(job,'node_reset_reinit_receipt','succeeded',JSON.stringify(receipt));
      }
      await this.step(job,'node_reset_verify_disk','started','核验原系统盘恢复完成及原挂载关系。');
      // Read twice after the receipt; never infer completion from HTTP acceptance alone.
      let ready=0;
      await this.waitFor(job,target,account,assertClaim,async()=>{
        const disk=await this.cloud.disk(account,target.systemDiskId);
        if(disk.Type!=='system'||disk.Status!=='ReIniting'&&disk.InstanceId!==target.instanceId) throw new Error('RESET_SYSTEM_DISK_CHANGED');
        ready=disk.Status==='In_use'?ready+1:0;return ready>=2;
      });
      await this.step(job,'node_reset_verify_disk','succeeded','原系统盘已恢复为使用中，磁盘 ID 与挂载主机一致。');
      diskReady=true;
      if(target.originalPowerState==='Running'||target.hasDns) {
        const host=await this.cloud.host(account,target.instanceId);
        if(host.Status==='Stopped') {
          await this.current(job,target,assertClaim);
          const receipt=await this.cloud.start(account,target.instanceId);
          await this.step(job,'node_reset_start','succeeded',JSON.stringify(receipt));
        } else if(host.Status!=='Running'&&host.Status!=='Starting') throw new Error('RESET_POWER_STATE_CHANGED');
        await this.waitFor(job,target,account,assertClaim,async()=> (await this.cloud.host(account,target.instanceId)).Status==='Running');
      }
      if(target.hasDns) {
        await this.current(job,target,assertClaim);
        await this.step(job,'node_reset_dns','started','恢复已部署 DNS 并独立核验。');
        const result=await this.dns.verify(instance.id,target.nodeId,{id:job.triggeredBy,role:'admin'},job.id,true);
        if(result.status!=='verified') throw new Error('RESET_DNS_UNVERIFIED');
        await this.step(job,'node_reset_dns','succeeded','已部署 DNS 核验通过。');
      }
      if(target.originalPowerState==='Stopped'&&(await this.cloud.host(account,target.instanceId)).Status==='Running') {
        await this.current(job,target,assertClaim);
        const receipt=await this.cloud.stop(account,target.instanceId);
        await this.step(job,'node_reset_restore_power','succeeded',JSON.stringify(receipt));
        await this.waitFor(job,target,account,assertClaim,async()=> (await this.cloud.host(account,target.instanceId)).Status==='Stopped');
      }
      await this.current(job,target,assertClaim);
      await this.checkCloud(instance,target,account,false);
      if((await this.cloud.host(account,target.instanceId)).Status!==target.originalPowerState) throw new Error('RESET_POWER_UNVERIFIED');
      await this.step(job,'node_reset_verified','succeeded','系统盘恢复完成；原 ECS、磁盘、网络、到期时间及电源状态已核验。');
    } catch(error) {
      // Never start an original running host on an unknown disk result.
      const rejected=error instanceof NodeResetCloudError&&error.action==='ReInitDisk'&&error.rejected;
      if((!reinitIntent||rejected)&&target.originalPowerState==='Running') {
        try {
          await this.current(job,target,assertClaim);
          await this.checkCloud(instance,target,account,false);
          if((await this.cloud.host(account,target.instanceId)).Status==='Stopped') {
            const receipt=await this.cloud.start(account,target.instanceId);
            await this.step(job,'node_reset_restore_power','succeeded',JSON.stringify(receipt));
          }
        } catch { /* Preserve the failed stage; do not broaden recovery or recreate the host. */ }
      }
      // A stopped node may have been temporarily started for DNS. A DNS failure
      // must not silently leave it running once the reset disk is proven ready.
      if(diskReady&&target.originalPowerState==='Stopped'&&target.hasDns) {
        try {
          await this.current(job,target,assertClaim);
          await this.checkCloud(instance,target,account,false);
          if((await this.cloud.host(account,target.instanceId)).Status==='Running') {
            const receipt=await this.cloud.stop(account,target.instanceId);
            await this.waitFor(job,target,account,assertClaim,async()=>(await this.cloud.host(account,target.instanceId)).Status==='Stopped');
            await this.step(job,'node_reset_restore_power','succeeded',JSON.stringify(receipt));
          }
        } catch { /* Keep the original failure visible; never force-stop or reset again. */ }
      }
      throw new ConflictException(this.failure(error,reinitIntent&&!rejected));
    }
  }

  private async prepare(instance:RangeInstanceRecord,nodeId:string) {
    assertPowerAllowsMutation(instance);
    if(instance.status!=='running') throw new ConflictException('仅已创建且无活动任务的编排实例可重置节点。');
    this.assertLifetime(instance);
    const jobs=await this.repository.listProvisionJobs();
    if(jobs.some(job=>job.rangeInstanceId===instance.id&&['pending','running'].includes(job.status))) throw new ConflictException('实例存在活动任务，请等待完成。');
    for(const job of jobs.filter(job=>job.rangeInstanceId===instance.id&&job.jobType==='reset'&&job.topologySnapshot?.nodeReset?.nodeId===nodeId)) {
      const steps=await this.repository.listProvisionJobStepLogs(job.id);
      if(steps.some(step=>step.stepName==='node_reset_reinit_intent')&&!steps.some(step=>
        step.stepName==='node_reset_reinit_receipt'&&step.status==='succeeded'||step.stepName==='node_reset_reinit_rejected'&&step.status==='failed'))
        throw new ConflictException('该节点上次重置结果未知，不能再次重置；请核验原任务。');
    }
    const summary=instance.resourceSummary!,context=summary.executionContext;
    const host=this.node(instance,nodeId)!;
    const instanceId=summary.hostIds?.[nodeId],systemDiskId=summary.systemDiskIds?.[nodeId];
    const imageId=summary.resolvedImageIds?.[nodeId]??host.imageId??host.imageStrategy?.imageId;
    if(!context?.cloudAccountContextId||!context.cloudAccountUid||!context.regionId||!instanceId||!systemDiskId||typeof imageId!=='string')
      throw new ConflictException('缺少已部署主机、镜像或系统盘的准确来源，不能重置。');
    const source=(await readPatrolInventories(this.repository,[instance],jobs,{provider:'alibaba_cloud',accountUid:context.cloudAccountUid,cloudWorkspaceId:requireCurrentCloudWorkspaceId()}))
      .find(row=>row.context.cloudAccountContextId===context.cloudAccountContextId&&row.context.regionId===context.regionId);
    if(!source?.proven.has(`ecs:${instanceId}`)||!source.proven.has(`disk:${systemDiskId}`)
      ||summary.diskInventoryHostIds?.[nodeId]!==instanceId||summary.diskOwnershipProofs?.[systemDiskId]?.instanceId!==instanceId
      ||summary.diskOwnershipProofs?.[systemDiskId]?.method!=='persisted') throw new ConflictException('主机与系统盘缺少同来源创建及挂载证明，不能重置。');
    this.password(instance,nodeId);
    const targetBase={version:1 as const,cloudWorkspaceId:requireCurrentCloudWorkspaceId(),ownerUserId:instance.ownerUserId,nodeId,
      nodeName:String(host.label??host.name??nodeId),instanceId,systemDiskId,imageId,sourceJobId:source.birthSources.get(`ecs:${instanceId}`)!,
      cloudAccountContextId:context.cloudAccountContextId,accountUid:context.cloudAccountUid,regionId:context.regionId};
    const account=await this.account(instance,targetBase);
    await this.cloud.verifyAccount(account);
    const cloudHost=await this.cloud.host(account,instanceId);
    if(!['Running','Stopped'].includes(cloudHost.Status)) throw new ConflictException('节点正在转换电源状态，暂不能重置。');
    const autoReleaseTime=iso(cloudHost.AutoReleaseTime);
    if(autoReleaseTime&&Date.parse(autoReleaseTime)<=Date.now()+10*60_000) throw new ConflictException('距云端自动释放不足 10 分钟，不能重置系统盘。');
    const disks=await this.cloud.disks(account,instanceId);
    // A topology update can legitimately refresh PlatformCreateJobId on existing
    // hosts. Keep the birth proof separate; an observation never grants creation.
    const tagJobId=this.tags(cloudHost).PlatformCreateJobId;
    const tagJob=jobs.find(job=>job.id===tagJobId&&job.rangeInstanceId===instance.id&&job.cloudWorkspaceId===instance.cloudWorkspaceId
      &&['create','retry','update'].includes(job.jobType));
    if(!tagJob||!source.sourceJobIds.includes(tagJobId)) throw new Error('RESET_TAG_JOB_UNVERIFIED');
    // Other disks are observed solely to prove preservation, never adopted for deletion or billing.
    const dataDiskIds=sorted(disks.filter(disk=>disk.Type==='data').map(disk=>disk.DiskId));
    const target:RangeNodeResetTarget={...targetBase,tagJobId,originalPowerState:cloudHost.Status,dataDiskIds,
      networkDigest:hash(this.network(cloudHost)),autoReleaseTime,expiresAt:instance.expiresAt?.toISOString()??null,
      hasDns:!!host.dns};
    await this.checkCloud(instance,target,account,false,cloudHost,disks);
    await this.cloud.image(account,imageId);
    const preview:RangeNodeResetPreview={...target,rangeInstanceId:instance.id,planDigest:hash({target,updatedAt:instance.updatedAt.toISOString()}),destructive:true};
    return {preview,account};
  }
  private async account(instance:RangeInstanceRecord,target:Pick<RangeNodeResetTarget,'cloudAccountContextId'|'accountUid'|'regionId'>) {
    const context=instance.resourceSummary?.executionContext;
    const account=await this.config.getExecutionAccountContext({cloudAccountContextId:target.cloudAccountContextId});
    if(account.provider!=='alibaba_cloud'||account.accountUid!==target.accountUid||account.defaultRegion!==target.regionId
      ||account.cloudAccountContextId!==target.cloudAccountContextId||context?.cloudAccountUid!==target.accountUid
      ||context.cloudAccountContextId!==target.cloudAccountContextId||context.regionId!==target.regionId||!account.accountUidResolved)
      throw new ConflictException('原冻结账号、厂商或地域不一致，未执行重置。');
    return account;
  }
  private async checkCloud(instance:RangeInstanceRecord,target:RangeNodeResetTarget,account:SystemCloudAccountContext,transitional:boolean,host?:ResetCloudRow,disks?:ResetCloudRow[]) {
    host??=await this.cloud.host(account,target.instanceId);
    disks??=await this.cloud.disks(account,target.instanceId);
    const tags=this.tags(host);
    if(host.InstanceId!==target.instanceId||host.ImageId!==target.imageId||host.RegionId!==target.regionId
      ||tags.CreatedBy!=='cyber-range-platform'||tags.RangeInstanceId!==instance.id||tags.CloudAccountUid!==target.accountUid
      ||tags.PlatformManaged!=='true'||tags.PlatformHostKey!==target.nodeId||tags.PlatformResourceType!=='ecs'
      ||tags.ExecutionBackend!=='opentofu'||tags.CloudProvider!=='alibaba_cloud'
      ||tags.CloudAccountContextId!==target.cloudAccountContextId||tags.PlatformCreateJobId!==target.tagJobId
      ||instance.ownerUserId&&tags.PlatformUserId!==instance.ownerUserId)
      throw new Error('RESET_HOST_SOURCE_CHANGED');
    if(hash(this.network(host))!==target.networkDigest||iso(host.AutoReleaseTime)!==target.autoReleaseTime) throw new Error('RESET_NETWORK_OR_EXPIRY_CHANGED');
    const system=disks.filter(disk=>disk.Type==='system');
    if(transitional&&system.length===0) system.push(await this.cloud.disk(account,target.systemDiskId));
    if(system.length!==1||system[0].DiskId!==target.systemDiskId||system[0].ImageId!==target.imageId
      ||system[0].InstanceId!==target.instanceId&&!(transitional&&system[0].Status==='ReIniting'&&!system[0].InstanceId)
      ||system[0].DeleteWithInstance!==true
      ||system[0].MultiAttach&&system[0].MultiAttach!=='Disabled'
      ||!transitional&&system[0].Status!=='In_use') throw new Error('RESET_SYSTEM_DISK_CHANGED');
    if(disks.some(disk=>disk.InstanceId!==target.instanceId&&!(transitional&&disk.DiskId===target.systemDiskId&&disk.Type==='system'&&disk.Status==='ReIniting'&&!disk.InstanceId)||!['system','data'].includes(disk.Type))
      ||JSON.stringify(sorted(disks.filter(disk=>disk.Type==='data').map(disk=>disk.DiskId)))!==JSON.stringify(target.dataDiskIds))
      throw new Error('RESET_DISK_ATTACHMENTS_CHANGED');
  }
  private async current(job:ProvisionJobRecord,target:RangeNodeResetTarget,assertClaim:()=>Promise<void>) {
    await assertClaim();
    const instance=await this.repository.getRangeInstanceById(job.rangeInstanceId);
    if(!instance||instance.cloudWorkspaceId!==target.cloudWorkspaceId||instance.ownerUserId!==target.ownerUserId
      ||instance.instanceMode!=='range'||instance.cloudProvider!=='alibaba_cloud'||instance.lastJobId!==job.id||instance.status!=='running'
      ||instance.resourceSummary?.hostIds?.[target.nodeId]!==target.instanceId||instance.resourceSummary?.systemDiskIds?.[target.nodeId]!==target.systemDiskId
      ||instance.expiresAt?.toISOString()!== (target.expiresAt??undefined)) throw new Error('RESET_SOURCE_CHANGED');
    this.assertLifetime(instance,0);
    if(target.autoReleaseTime&&Date.parse(target.autoReleaseTime)<=Date.now()) throw new Error('RESET_CLOUD_DEADLINE_EXPIRED');
    await this.account(instance,target);
    return instance;
  }
  private node(instance:RangeInstanceRecord,nodeId:string):any {
    const nodes=(instance.runtimeTopologyGraph as any)?.nodes;
    return Array.isArray(nodes)?nodes.find(node=>node.id===nodeId&&node.kind==='ecs'):null;
  }
  private password(instance:RangeInstanceRecord,nodeId:string) {
    const value=instance.runtimeCredentials?.[nodeId]?.password;
    if(typeof value!=='string'||value.length<8||value.length>30||[/[A-Z]/,/[a-z]/,/[0-9]/,/[^A-Za-z0-9]/].filter(pattern=>pattern.test(value)).length<3)
      throw new ConflictException('缺少可恢复的有效节点登录凭据，不能重置系统盘。');
    return value;
  }
  private network(host:ResetCloudRow) {
    const strings=(value:any)=>Array.isArray(value)&&value.every(item=>typeof item==='string')?sorted(value):[];
    const result={vpcId:host.VpcAttributes?.VpcId??null,vswitchId:host.VpcAttributes?.VSwitchId??null,
      privateIps:strings(host.VpcAttributes?.PrivateIpAddress?.IpAddress),publicIps:strings(host.PublicIpAddress?.IpAddress),
      securityGroupIds:strings(host.SecurityGroupIds?.SecurityGroupId),eipId:host.EipAddress?.AllocationId??null,
      eniIds:sorted((host.NetworkInterfaces?.NetworkInterface??[]).map((nic:any)=>String(nic.NetworkInterfaceId)))};
    if(!result.vpcId||!result.vswitchId||!result.privateIps.length||!result.securityGroupIds.length||!result.eniIds.length
      ||result.eniIds.some(id=>!/^eni-[A-Za-z0-9-]+$/.test(id))) throw new Error('RESET_NETWORK_UNVERIFIED');
    return result;
  }
  private tags(host:ResetCloudRow) {
    const values=host.Tags?.Tag;if(!Array.isArray(values)) throw new Error('RESET_TAGS_UNVERIFIED');
    const tags:Record<string,string>=Object.create(null);
    for(const tag of values){const key=tag?.TagKey??tag?.Key,value=tag?.TagValue??tag?.Value;
      if(typeof key!=='string'||typeof value!=='string'||Object.hasOwn(tags,key)) throw new Error('RESET_TAGS_UNVERIFIED');tags[key]=value;}
    return tags;
  }
  private assertLifetime(instance:RangeInstanceRecord,bufferMs=10*60_000) {
    if(instance.expiresAt&&instance.expiresAt.getTime()<=Date.now()+bufferMs)
      throw new ConflictException(bufferMs?'实例已到期或距到期不足 10 分钟，不能执行系统盘重置。':'实例已到期，停止重置，不延长原到期时间。');
  }
  private async waitFor(job:ProvisionJobRecord,target:RangeNodeResetTarget,account:SystemCloudAccountContext,assertClaim:()=>Promise<void>,done:()=>Promise<boolean>) {
    for(let attempt=0;attempt<120;attempt++) {
      await this.current(job,target,assertClaim);
      if(await done()) return;
      await sleep(process.env.NODE_ENV==='test'?0:5_000);
    }
    throw new Error('RESET_CLOUD_WAIT_TIMEOUT');
  }
  private async step(job:ProvisionJobRecord,stepName:string,status:'started'|'succeeded'|'failed',message:string) {
    if(status!=='started') {
      const prior=(await this.repository.listProvisionJobStepLogs(job.id)).find(step=>step.stepName===stepName&&step.status==='running');
      if(prior) return this.repository.updateProvisionJobStepLog(prior.id,{status,message,finishedAt:new Date()});
    }
    return this.repository.createProvisionJobStepLog({jobId:job.id,stepName,status:status==='started'?'running':status,
      message,startedAt:new Date(),...(status==='started'?{}:{finishedAt:new Date()})});
  }
  private failure(error:unknown,mayHaveReset:boolean) {
    const cloud=error instanceof NodeResetCloudError?`阿里云 ${error.action}：${error.code}${error.requestId?`（请求 ID ${error.requestId}）`:''}。`:'';
    const code=error instanceof Error&&/^RESET_[A-Z_]+$/.test(error.message)?`（${error.message}）`:'';
    return `${cloud}${mayHaveReset?'系统盘恢复可能已执行，后续核验未完成；禁止自动重复重置。':'节点重置未完成，未重建或销毁实例。'}${code}请查看原任务阶段与电源状态。`;
  }
}
