import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SystemCloudAccountContext } from './system-config.service';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { sanitizeAliyunErrorCode } from './aliyun-error-code';

export type ResetCloudRow = Record<string, any>;
type ResetCloudAction = 'GetCallerIdentity' | 'DescribeInstances' | 'DescribeDisks' | 'DescribeImages' | 'StopInstance' | 'StartInstance' | 'ReInitDisk';
export class NodeResetCloudError extends Error {
  constructor(readonly action: string, readonly code: string, readonly requestId: string | null, readonly rejected: boolean) {
    super(`NODE_RESET_CLOUD:${action}:${code}`);
  }
}

@Injectable()
export class RangeNodeResetCloudClient {
  async verifyAccount(account: SystemCloudAccountContext) {
    const body = await this.rpc(account,'GetCallerIdentity',{});
    if (String(body.AccountId) !== account.accountUid) throw new Error('RESET_ACCOUNT_MISMATCH');
  }
  async host(account: SystemCloudAccountContext, id: string) {
    const rows = await this.pages(account,'DescribeInstances',{InstanceIds:JSON.stringify([id])},'Instances','Instance','InstanceId');
    if (rows.length !== 1 || rows[0].InstanceId !== id) throw new Error('RESET_HOST_NOT_EXACT');
    return rows[0];
  }
  async disks(account: SystemCloudAccountContext, hostId: string) {
    return this.pages(account,'DescribeDisks',{InstanceId:hostId},'Disks','Disk','DiskId');
  }
  async disk(account: SystemCloudAccountContext, id: string) {
    const rows = await this.pages(account,'DescribeDisks',{DiskIds:JSON.stringify([id])},'Disks','Disk','DiskId');
    if (rows.length !== 1 || rows[0].DiskId !== id) throw new Error('RESET_DISK_NOT_EXACT');
    return rows[0];
  }
  async image(account: SystemCloudAccountContext, id: string) {
    const body=await this.rpc(account,'DescribeImages',{ImageId:id,PageNumber:'1',PageSize:'10'});
    const rows=body.Images?.Image;
    if (!Array.isArray(rows) || rows.length !== 1 || body.TotalCount !== 1&&body.TotalCount !== '1' || rows[0]?.ImageId !== id
      || rows[0].Status !== 'Available') throw new Error('RESET_IMAGE_UNAVAILABLE');
    return rows[0];
  }
  async stop(account: SystemCloudAccountContext, id: string) {
    return this.receipt(await this.rpc(account,'StopInstance',{InstanceId:id,ForceStop:'false',StoppedMode:'KeepCharging'}));
  }
  async start(account: SystemCloudAccountContext, id: string) {
    return this.receipt(await this.rpc(account,'StartInstance',{InstanceId:id}));
  }
  async reinitialize(account: SystemCloudAccountContext, diskId: string, password: string) {
    return this.receipt(await this.rpc(account,'ReInitDisk',{DiskId:diskId,Password:password,AutoStartInstance:'false'}));
  }
  private receipt(body: ResetCloudRow) { return {requestId:body.RequestId as string}; }
  private async pages(account: SystemCloudAccountContext, action: 'DescribeInstances'|'DescribeDisks', parameters: Record<string,string>, container: string, set: string, idKey: string) {
    const result: ResetCloudRow[]=[],ids=new Set<string>(),tokens=new Set<string>();
    let token: string|undefined;
    for(let page=0;page<100;page++) {
      const body=await this.rpc(account,action,{...parameters,MaxResults:'100',...(token?{NextToken:token}:{})});
      const rows=body[container]?.[set];
      if(!Array.isArray(rows)||rows.length>100) throw new Error('RESET_INCOMPLETE_CLOUD_PAGE');
      for(const row of rows) {
        if(!row||typeof row[idKey]!=='string'||!row[idKey].trim()||ids.has(row[idKey])) throw new Error('RESET_DUPLICATE_CLOUD_ID');
        ids.add(row[idKey]);result.push(row);
      }
      // These APIs document TotalCount as meaningless for token pagination.
      if(body.NextToken===undefined||body.NextToken===null||body.NextToken==='') return result;
      if(typeof body.NextToken!=='string'||tokens.has(body.NextToken)) throw new Error('RESET_INCOMPLETE_CLOUD_PAGE');
      token=body.NextToken;tokens.add(token);
    }
    throw new Error('RESET_CLOUD_PAGE_LIMIT');
  }
  private async rpc(account: SystemCloudAccountContext, action: ResetCloudAction, parameters: Record<string,string>) {
    if(account.provider!=='alibaba_cloud'||!account.accountUidResolved) throw new Error('RESET_ACCOUNT_UNVERIFIED');
    const sts=action==='GetCallerIdentity';
    const secrets=[account.accessKeyId,account.accessKeySecret,parameters.Password].filter(Boolean);
    const query=signAliyunRpcQuery({Action:action,AccessKeyId:account.accessKeyId,Format:'JSON',RegionId:account.defaultRegion,
      SignatureMethod:'HMAC-SHA1',SignatureNonce:randomUUID(),SignatureVersion:'1.0',Timestamp:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),
      Version:sts?'2015-04-01':'2014-05-26',...parameters},account.accessKeySecret);
    let response: Response,body: ResetCloudRow;
    try { response=await fetch(`https://${sts?'sts.aliyuncs.com':`ecs.${account.defaultRegion}.aliyuncs.com`}/?${query}`,{signal:AbortSignal.timeout(30_000)}); }
    catch { throw new NodeResetCloudError(action,'REQUEST_UNVERIFIED',null,false); }
    try { body=await response.json(); } catch { throw new NodeResetCloudError(action,'RESPONSE_UNVERIFIED',null,false); }
    const requestId=typeof body?.RequestId==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(body.RequestId)
      && !secrets.some(secret=>body.RequestId.includes(secret)) ? body.RequestId : null;
    const errorCode=body&&typeof body==='object'&&!Array.isArray(body)?sanitizeAliyunErrorCode(body.Code,secrets):null;
    if(!body||typeof body!=='object'||Array.isArray(body)||!response.ok||body.Code&&body.Code!=='Success'||!requestId) {
      throw new NodeResetCloudError(action,errorCode??'RESPONSE_UNVERIFIED',requestId,
        !!requestId&&response.status>=400&&response.status<500);
    }
    return body;
  }
}
