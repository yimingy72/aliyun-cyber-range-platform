import { readSingleInstanceCreationRejection } from '../src/admin/single-instance-creation-rejection';
import { buildProvisionJobEvidence } from '../src/admin/provision-job-evidence';

const start=new Date('2026-10-14T14:34:00Z'),at=new Date('2026-10-14T15:43:00Z');
const context={provider:'alibaba_cloud',cloudAccountContextId:'context',cloudAccountUid:'1234',regionId:'cn-beijing',zoneId:'cn-beijing-h'};
const instance:any={id:'single',cloudWorkspaceId:'workspace',instanceMode:'single',cloudProvider:'alibaba_cloud',singleInstanceBatchId:'batch',
  singleInstanceConfig:{executionBackend:'opentofu',cloudAccountContextId:'context',cloudAccountUid:'1234',regionId:'cn-beijing',zoneId:'cn-beijing-h',imageId:'m-original',systemDiskSize:40}};
const source:any={id:'create',rangeInstanceId:'single',cloudWorkspaceId:'workspace',jobType:'create',status:'failed',retryCount:0,startedAt:start,finishedAt:start};
const recovery:any={...source,id:'destroy',jobType:'destroy',status:'succeeded',startedAt:at,finishedAt:at};
const value={version:1,rangeInstanceId:'single',sourceProvisionJobId:'create',executionContext:context,reason:'InvalidSystemDiskSize.LessThanImageSize',
  imageId:'m-original',requestedSystemDiskSize:40,minimumSystemDiskSize:64,requestId:'image-query-request'};
const step:any={jobId:'destroy',cloudWorkspaceId:'workspace',stepName:'single_instance_create_rejection',status:'succeeded',startedAt:at,finishedAt:at,createdAt:at,message:JSON.stringify(value)};
describe('recorded single instance creation rejection',()=>{
  it('projects exact rejection evidence from successful recovery without disclosing raw output or credentials',()=>{
    const log={...step,message:JSON.stringify({...value,password:'private-password',executionContext:{...context,accessKeySecret:'private-key'}}),stdoutExcerpt:'private-output'};
    const result=readSingleInstanceCreationRejection(instance,recovery,log,[source,recovery]);
    expect(result).toMatchObject({sourceProvisionJobId:'create',recoveryProvisionJobId:'destroy',cloudAccountUid:'1234',requestedSystemDiskSizeGiB:40,
      minimumSystemDiskSizeGiB:64,imageQueryRequestId:'image-query-request',coverage:'platform_verified_immutable_image_constraint'});
    const evidence=buildProvisionJobEvidence(recovery,[log],[source,recovery],[],instance);
    expect(evidence.creationRejections).toEqual([result]);expect(JSON.stringify(evidence)).not.toMatch(/private|password|accessKeySecret|stdoutExcerpt/);
  });
  it.each([
    {sourceProvisionJobId:'other'}, {rangeInstanceId:'other'}, {executionContext:{...context,cloudAccountUid:'4321'}},
    {imageId:'m-replaced'}, {requestedSystemDiskSize:64}, {minimumSystemDiskSize:40}, {minimumSystemDiskSize:NaN}, {requestId:''},
  ])('rejects mismatched or insufficient historical proof: %p',changes=>{
    expect(readSingleInstanceCreationRejection(instance,recovery,{...step,message:JSON.stringify({...value,...changes})},[source,recovery])).toBeNull();
  });
  it('does not treat cleanup success, an error string, a foreign claim or a retried submission as rejection proof',()=>{
    expect(readSingleInstanceCreationRejection(instance,recovery,{...step,stepName:'prepare'},[source,recovery])).toBeNull();
    expect(readSingleInstanceCreationRejection(instance,recovery,{...step,message:'InvalidSystemDiskSize.LessThanImageSize'},[source,recovery])).toBeNull();
    expect(readSingleInstanceCreationRejection(instance,{...recovery,status:'failed'},step,[source,recovery])).toBeNull();
    expect(readSingleInstanceCreationRejection(instance,recovery,{...step,cloudWorkspaceId:'other'},[source,recovery])).toBeNull();
    expect(readSingleInstanceCreationRejection(instance,recovery,{...step,startedAt:start},[source,recovery])).toBeNull();
    expect(readSingleInstanceCreationRejection(instance,recovery,step,[{...source,retryCount:1},recovery])).toBeNull();
    expect(readSingleInstanceCreationRejection(instance,recovery,step,[{...source,status:'succeeded'},recovery])).toBeNull();
  });
});
