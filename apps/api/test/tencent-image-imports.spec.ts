import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateImageImportDto } from '../src/admin/dto/image-import.dto';
import { ImageImportsService } from '../src/admin/image-imports.service';
import { requestTencentCloud, TencentCloudRequestError } from '../src/admin/tencent-cloud-client';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
jest.mock('../src/admin/tencent-cloud-client', () => ({ ...jest.requireActual('../src/admin/tencent-cloud-client'), requestTencentCloud: jest.fn() }));
const rpc = requestTencentCloud as jest.Mock;
const context = { id: 'ctx-owned', provider: 'tencent_cloud' as const, accountUid: '123456', regionId: 'ap-guangzhou', zoneId: 'ap-guangzhou-3', accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret', imageImportBucket: '', status: 'ready' as const };
const user = { id: 'owner', username: 'owner', role: 'user' as const };
const input = { cloudContextId: context.id, displayName: 'fixture', platform: 'Ubuntu', osVersion: '22.04', osType: 'linux' as const, architecture: 'x86_64' as const, bootMode: 'BIOS' as const, imageFormat: 'qcow2' as const, systemDiskSize: 40, sourceFileName: 'fixture.qcow2', sourceSizeBytes: 4096 };
const response = (set:string, rows:any[]) => ({RequestId:'fixture',TotalCount:rows.length,[set]:rows});
function matches(row:any, where:any):boolean { return Object.entries(where).every(([key,value]:any) => key==='OR' ? value.some((test:any)=>matches(row,test)) : value && typeof value==='object' && !(value instanceof Date) ? (!('gt' in value)||row[key]>value.gt)&&(!('lte' in value)||row[key]<=value.lte) : row[key]===value); }
function fixture() {
  const repository = createMemoryAdminRepository(); let job:any, cloudImage:any=null, deleted=false;
  const imageImportJob = { create:jest.fn(async ({data}) => job={ id:'job-owned', ...data, defaultPassword:null, defaultHostName:null, description:null, imageId:null, taskId:null, status:'awaiting_upload', uploadCompletedAt:null, submissionRejected:false, sourceSnapshotId:null, platformImageAssetId:null, backingSnapshotIds:[], deletedSnapshotIds:[], snapshotCleanupCompletedAt:null, cloudImageDeletedAt:null, temporaryObjectDeletedAt:null, leaseToken:null, leaseExpiresAt:null, createdAt:new Date(), updatedAt:new Date() }),
    findUnique:jest.fn(async()=>({...job})), updateMany:jest.fn(async({where,data})=>{if(!matches(job,where))return {count:0};Object.assign(job,data);return {count:1};}),
    update:jest.fn(async({where,data})=>{if(!matches(job,where))throw new Error('stale claim');Object.assign(job,data);return {...job};}) };
  const bucket={id:'bucket-owned',bucketName:'fixture-owned-1250000000',cloudWorkspaceId:'workspace-owned',cloudAccountContextId:context.id,cloudAccountUid:context.accountUid,regionId:context.regionId,appId:'1250000000',cloudProvider:'tencent_cloud' as const};
  const cos={ withImportBucket:jest.fn(async(_,run)=>run(bucket)), getOwnedBucket:jest.fn(async()=>bucket), cleanupIfIdle:jest.fn(async()=>undefined),
    presignObject:jest.fn(async(params:any)=>({url:'https://synthetic-upload.invalid/object',headers:params.headers??{}})), requestObject:jest.fn(async(params:any)=>{
      if(params.method==='DELETE'){deleted=true;return new Response(null,{status:204});}
      if(deleted)return new Response(null,{status:404});
      return new Response(null,{status:200,headers:{'content-length':'4096',etag:'"synthetic-etag"','x-cos-meta-platform-image-job':job.id,'x-cos-meta-platform-image-owner':user.id,'x-cos-meta-platform-cloud-context':context.id}});
    }) };
  const getCredentials = jest.fn(async () => context);
  const service=new ImageImportsService(repository,{imageImportJob} as never,{getCredentials} as never,undefined,cos as never);
  rpc.mockImplementation(async(call:any)=>{
    if(call.action==='DescribeImportImageOs')return {RequestId:'fixture',ImportImageOsListSupported:{Linux:['Ubuntu'],Windows:[]},ImportImageOsVersionSet:[{OsName:'Ubuntu',OsVersions:['22.04'],Architecture:['x86_64']}]};
    if(call.action==='ImportImage'){cloudImage={ImageId:'img-owned',ImageName:'fixture',ImageType:'PRIVATE_IMAGE',ImageState:'IMPORTING',ImageSize:40,Tags:call.parameters.TagSpecification[0].Tags,SnapshotSet:[{SnapshotId:'snap-owned'}]};return {RequestId:'fixture',ImageId:'img-owned'};}
    if(call.action==='DescribeImages')return response('ImageSet',cloudImage?[cloudImage]:[]);
    if(call.action==='DescribeSnapshots')return response('SnapshotSet',[{SnapshotId:'snap-owned',DiskId:'disk-imported',CreateTime:job.uploadCompletedAt.toISOString(),SnapshotType:'PRIVATE_SNAPSHOT',SnapshotState:'NORMAL',CopyFromRemote:false,ShareReference:0,Images:[{ImageId:'img-owned'}],Tags:[]}]);
    if(call.action==='TagResources')return {RequestId:'fixture',FailedResources:[]};
    throw new Error(`Unexpected synthetic action ${call.action}`);
  });
  return {repository,service,imageImportJob,cos,getCredentials,getJob:()=>job,setImageState:(state:string)=>cloudImage.ImageState=state};
}
beforeEach(()=>rpc.mockReset());
describe('Tencent import frozen sources and safe recovery',()=>{
  it('accepts Tencent VMDK through the DTO and submits it using the COS source, not Alibaba disk parameters', async () => {
    const payload = { ...input, imageFormat: 'vmdk' as const, sourceFileName: 'fixture.vmdk' };
    expect(await validate(plainToInstance(CreateImageImportDto, payload))).toEqual([]);
    const f = fixture();
    await f.service.createUpload(payload, user);
    await f.service.completeUpload('job-owned', user);
    expect(f.getJob()).toMatchObject({ cloudProvider: 'tencent_cloud', imageFormat: 'vmdk', sourceFileName: 'fixture.vmdk' });
    const submit = rpc.mock.calls.find(([call]) => call.action === 'ImportImage')![0];
    expect(submit.parameters.ImageUrl).toBe('https://synthetic-upload.invalid/object');
    expect(Object.keys(submit.parameters).some(key => key.startsWith('DiskDeviceMapping.'))).toBe(false);
    expect(f.cos.presignObject.mock.calls[0][0].objectKey).toMatch(/\/fixture\.vmdk$/);
  });
  it.each(['iso', 'vhdx'])('rejects unsupported %s before bucket or job creation', async format => {
    const f = fixture();
    await expect(f.service.createUpload({ ...input, imageFormat: format, sourceFileName: `fixture.${format}` } as never, user)).rejects.toThrow('当前云账号仅支持');
    expect(f.cos.withImportBucket).not.toHaveBeenCalled(); expect(f.imageImportJob.create).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['IMAGE_IMPORT_MAX_BYTES', String(10 * 1024 ** 3), 5 * 1024 ** 3 + 1, '5 GiB'],
    ['IMAGE_IMPORT_MAX_DURATION_MS', String(25 * 60 * 60_000), 4096, '24 小时'],
  ] as const)('validates Tencent constraints before creating storage when %s is raised', async (key, value, sourceSizeBytes, message) => {
    const original = process.env[key]; process.env[key] = value;
    try {
      const f = fixture();
      await expect(f.service.createUpload({ ...input, sourceSizeBytes }, user)).rejects.toThrow(message);
      expect(f.cos.withImportBucket).not.toHaveBeenCalled(); expect(f.imageImportJob.create).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
    } finally { if (original === undefined) delete process.env[key]; else process.env[key] = original; }
  });
  it('does not mark an unsubmitted image unknown when COS timeout configuration changes after upload', async () => {
    const original = process.env.IMAGE_IMPORT_MAX_DURATION_MS;
    const f = fixture(); await f.service.createUpload(input, user);
    process.env.IMAGE_IMPORT_MAX_DURATION_MS = String(25 * 60 * 60_000);
    try {
      await expect(f.service.completeUpload('job-owned', user)).rejects.toThrow('24 小时');
      expect(f.getJob()).toMatchObject({ status: 'awaiting_upload', uploadCompletedAt: null, imageId: null });
      expect(f.cos.requestObject).not.toHaveBeenCalled();
      expect(rpc.mock.calls.some(([call]) => call.action === 'ImportImage')).toBe(false);
    } finally { if (original === undefined) delete process.env.IMAGE_IMPORT_MAX_DURATION_MS; else process.env.IMAGE_IMPORT_MAX_DURATION_MS = original; }
    expect(await f.service.completeUpload('job-owned', user)).toMatchObject({ status: 'importing', imageId: 'img-owned' });
  });
  it.each(['InvalidParameterValue.InvalidBootMode', 'InvalidParameter.InvalidParameterUrlError', 'RegionAbilityLimit.UnsupportedToImportImage', 'OperationDenied.InnerUserProhibitAction', 'RequestLimitExceeded'])('allows explicit retry of receipt-backed %s without silently resubmitting', async code => {
    const f = fixture(); await f.service.createUpload(input, user);
    const implementation = rpc.getMockImplementation()!;
    rpc.mockImplementation(async call => call.action === 'ImportImage' ? Promise.reject(new TencentCloudRequestError(code, 'rejected-receipt')) : implementation(call));
    expect(await f.service.completeUpload('job-owned', user)).toMatchObject({ status: 'failed', submissionRejected: true, imageId: null });
    expect(await f.service.completeUpload('job-owned', user)).toMatchObject({ status: 'failed' });
    expect(rpc.mock.calls.filter(([call]) => call.action === 'ImportImage')).toHaveLength(1);
    rpc.mockImplementation(implementation);
    expect(await f.service.retry('job-owned', user)).toMatchObject({ status: 'importing', imageId: 'img-owned' });
    expect(rpc.mock.calls.filter(([call]) => call.action === 'ImportImage')).toHaveLength(2);
    expect(f.cos.withImportBucket).toHaveBeenCalledTimes(1); expect(f.imageImportJob.create).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['InternalError', 'ambiguous-receipt'], ['NETWORK_OR_TIMEOUT', undefined], ['INVALID_RESPONSE', undefined],
    ['InvalidParameterValue.InvalidBootMode', undefined], ['OperationDeniedNewCode', 'unknown-receipt'],
  ])('keeps %s without reliable rejection proof unknown and never retries it', async (code, requestId) => {
    const f = fixture(); await f.service.createUpload(input, user);
    const implementation = rpc.getMockImplementation()!;
    rpc.mockImplementation(async call => call.action === 'ImportImage' ? Promise.reject(new TencentCloudRequestError(code!, requestId)) : implementation(call));
    expect(await f.service.completeUpload('job-owned', user)).toMatchObject({ status: 'importing', submissionRejected: false });
    expect(await f.service.completeUpload('job-owned', user)).toMatchObject({ status: 'importing' });
    await expect(f.service.retry('job-owned', user)).rejects.toThrow('失败导入任务');
    expect(rpc.mock.calls.filter(([call]) => call.action === 'ImportImage')).toHaveLength(1);
    expect(f.cos.requestObject.mock.calls.some(([call]) => call.method === 'DELETE')).toBe(false);
  });

  it('freezes the managed bucket, OS version and signed upload ownership headers',async()=>{
    const f=fixture();const result=await f.service.createUpload(input,user);
    expect(f.getJob()).toMatchObject({cloudProvider:'tencent_cloud',managedBucketId:'bucket-owned',imageImportBucket:'fixture-owned-1250000000',osVersion:'22.04'});
    expect(f.cos.presignObject.mock.calls[0][0].headers).toMatchObject({'content-length':'4096','x-cos-forbid-overwrite':'true','x-cos-meta-platform-image-job':'job-owned','x-cos-meta-platform-cloud-context':context.id});
    expect(result.job).not.toHaveProperty('sourceObjectProof');expect(result.job).not.toHaveProperty('objectKey');
  });
  it.each([
    { provider: 'alibaba_cloud' }, { accountUid: '654321' }, { regionId: 'ap-shanghai' },
  ])('refuses changed frozen upload ownership %j before contacting COS or submitting', async changed => {
    const f = fixture(); await f.service.createUpload(input, user);
    f.getCredentials.mockResolvedValue({ ...context, ...changed } as never); rpc.mockClear();
    await expect(f.service.completeUpload('job-owned', user)).rejects.toThrow('导入云账号或地域证明不匹配');
    expect(f.cos.requestObject).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
    expect(f.getJob()).toMatchObject({ status: 'awaiting_upload', imageId: null });
  });
  it('rejects an unsupported OS version before creating any bucket or upload job',async()=>{
    const f=fixture();await expect(f.service.createUpload({...input,osVersion:'not-supported'},user)).rejects.toThrow('支持矩阵');
    expect(f.cos.withImportBucket).not.toHaveBeenCalled();expect(f.imageImportJob.create).not.toHaveBeenCalled();
  });
  it('validates object source, submits atomically tagged import and keeps exact image/snapshot bills',async()=>{
    const f=fixture();await f.service.createUpload(input,user);await f.service.completeUpload('job-owned',user);
    const submit=rpc.mock.calls.find(([call])=>call.action==='ImportImage')![0];
    expect(submit.parameters).toMatchObject({OsType:'Ubuntu',OsVersion:'22.04',BootMode:'Legacy BIOS',Force:false,TagSpecification:[{ResourceType:'image',Tags:expect.arrayContaining([{Key:'PlatformImageImportJobId',Value:'job-owned'},{Key:'CloudAccountContextId',Value:context.id}])}]});
    expect(f.getJob().sourceObjectProof).toMatchObject({jobId:'job-owned',bucketId:'bucket-owned',contentLength:4096,etag:'"synthetic-etag"'});
    expect((await f.repository.listBillingLedgerResources()).map(row=>[row.cloudProvider,row.cloudResourceId]).sort()).toEqual([['tencent_cloud','img-owned'],['tencent_cloud','snap-owned']]);
    expect(f.getJob().sourceDiskIds).toEqual(['disk-imported']);
  });
  it('does not import a file whose owner/context proof has changed',async()=>{
    const f=fixture();await f.service.createUpload(input,user);
    f.cos.requestObject.mockResolvedValue(new Response(null,{status:200,headers:{'content-length':'4096',etag:'"synthetic"','x-cos-meta-platform-image-job':'job-owned','x-cos-meta-platform-image-owner':'foreign','x-cos-meta-platform-cloud-context':context.id}}));
    await expect(f.service.completeUpload('job-owned',user)).rejects.toThrow('证明不匹配');
    expect(rpc.mock.calls.some(([call])=>call.action==='ImportImage')).toBe(false);
  });
  it('never issues another import after an unknown accepted submission',async()=>{
    const f=fixture();await f.service.createUpload(input,user);
    const implementation=rpc.getMockImplementation()!;rpc.mockImplementation(async call=>call.action==='ImportImage'?Promise.reject(new TencentCloudRequestError('NETWORK_OR_TIMEOUT')):implementation(call));
    expect(await f.service.completeUpload('job-owned',user)).toMatchObject({status:'importing',submissionRejected:false});
    expect(await f.service.completeUpload('job-owned',user)).toMatchObject({status:'importing'});
    expect(rpc.mock.calls.filter(([call])=>call.action==='ImportImage')).toHaveLength(1);
    expect(f.getJob().temporaryObjectDeletedAt).toBeNull();
  });
  it('enables only the available image and marks the object removed only after a fresh HEAD 404',async()=>{
    const f=fixture();await f.service.createUpload(input,user);await f.service.completeUpload('job-owned',user);f.setImageState('NORMAL');
    f.getJob().uploadExpiresAt = new Date(0);
    expect(await f.service.refreshImport('job-owned')).toMatchObject({status:'available',temporaryObjectDeletedAt:expect.any(Date)});
    expect(f.cos.requestObject.mock.calls.slice(-2).map(([input])=>input.method)).toEqual(['DELETE','HEAD']);
    expect(f.cos.cleanupIfIdle).toHaveBeenCalled();
    expect((await f.repository.listBillingLedgerResources()).every(row=>row.releasedAt===null)).toBe(true);
  });
  it.each([false,true])('recovers an overdue NORMAL Tencent image without deleting the image or snapshot (lost ImageId: %s)',async lostImageId=>{
    const f=fixture();await f.service.createUpload(input,user);await f.service.completeUpload('job-owned',user);
    f.setImageState('NORMAL');f.getJob().uploadCompletedAt=new Date(Date.now()-25*60*60_000);
    f.getJob().uploadExpiresAt=new Date(0);if(lostImageId)f.getJob().imageId=null;rpc.mockClear();
    expect(await f.service.refreshImport('job-owned')).toMatchObject({status:'available',imageId:'img-owned',cloudImageDeletedAt:null,snapshotCleanupCompletedAt:null});
    expect(rpc.mock.calls.filter(([call])=>call.action.startsWith('Delete'))).toEqual([]);
    expect(await f.repository.getPlatformImageAssetById(f.getJob().platformImageAssetId)).toMatchObject({enabled:true});
    expect((await f.repository.listBillingLedgerResources()).every(row=>row.releasedAt===null)).toBe(true);
  });
});
