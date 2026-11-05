import {PrismaService} from '../src/database/prisma.service';
import {PrismaAdminRepository} from '../src/database/prisma-admin.repository';
import {runInCloudWorkspace,runInSystemCloudWorkspaceScope} from '../src/auth/cloud-workspace-scope';

const url=process.env.NODE_RESET_TEST_DATABASE_URL;
const databaseDescribe=url?describe:describe.skip;
const scope={cloudWorkspaceId:'node-reset-repository-fixture',provider:'alibaba_cloud' as const,accountUid:'10001'};
databaseDescribe('reset enum migration and atomic Prisma queue',()=>{
  const prisma=new PrismaService({datasources:{db:{url}}}),repository=new PrismaAdminRepository(prisma);
  beforeAll(async()=>runInSystemCloudWorkspaceScope(async()=>{
    await prisma.cloudWorkspace.create({data:{id:scope.cloudWorkspaceId,provider:scope.provider,accountUid:scope.accountUid,displayName:'ephemeral reset test'}});
  }));
  afterAll(async()=>{
    await runInSystemCloudWorkspaceScope(async()=>{
      await prisma.rangeInstance.updateMany({where:{cloudWorkspaceId:scope.cloudWorkspaceId},data:{lastJobId:null}});
      await prisma.provisionJob.deleteMany({where:{cloudWorkspaceId:scope.cloudWorkspaceId}});
      await prisma.rangeInstance.deleteMany({where:{cloudWorkspaceId:scope.cloudWorkspaceId}});
      await prisma.cloudWorkspace.delete({where:{id:scope.cloudWorkspaceId}});
    });await prisma.$disconnect();
  });
  it('writes the additive reset enum, serializes competing requests, and rejects a stale version',async()=>runInCloudWorkspace(scope,async()=>{
    const instance=await repository.createRangeInstance({name:'ephemeral queue test',status:'running',cloudProvider:'alibaba_cloud',instanceMode:'range'});
    const input={rangeInstanceId:instance.id,jobType:'reset' as const,triggeredBy:'fixture',expectedStatus:'running' as const,
      expectedOwnerUserId:null,expectedUpdatedAt:instance.updatedAt,nextStatus:'running' as const};
    const queued=await Promise.all(Array.from({length:5},()=>repository.queueRangeInstanceJob(input)));
    const jobs=queued.filter(job=>!!job);expect(jobs).toHaveLength(1);expect(jobs[0]?.jobType).toBe('reset');
    const claimed=await repository.claimRangeProvisionJob(jobs[0]!.id,new Date());expect(claimed?.status).toBe('running');
    await repository.updateRangeProvisionJob(claimed!.id,claimed!.startedAt!,{status:'succeeded',finishedAt:new Date()});
    expect(await repository.queueRangeInstanceJob(input)).toBeNull();
    expect(await repository.getRangeInstanceById(instance.id)).toMatchObject({status:'running',lastJobId:jobs[0]!.id});
  }));
});
