import { PrismaService } from '../src/database/prisma.service';
import { ResourcePatrolRepository } from '../src/admin/resource-patrol.repository';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { randomUUID } from 'node:crypto';

const database = process.env.RESOURCE_PATROL_DATABASE_TEST === '1' ? describe : describe.skip;
database('resource patrol PostgreSQL atomicity',()=>{
  const prisma=new PrismaService(),store=new ResourcePatrolRepository(prisma);
  const workspace=`patrol-${randomUUID()}`,manager=`manager-${randomUUID()}`;
  const scope={cloudWorkspaceId:workspace,provider:'alibaba_cloud' as const,accountUid:`uid-${randomUUID()}`};
  beforeAll(async()=>{
    await runInSystemCloudWorkspaceScope(async()=>{
      await prisma.cloudWorkspace.create({data:{id:workspace,provider:scope.provider,accountUid:scope.accountUid,displayName:'fixture'}});
      await prisma.platformUser.create({data:{id:manager,username:manager,loginUsername:manager,passwordHash:'fixture',role:'admin',status:'active',
        isPlatformManager:true,selectedCloudWorkspaceId:workspace}});
      await store.setManager(manager);
    });
  });
  afterAll(async()=>{await prisma.$disconnect();});
  it('acquires one lease across independent callers and fences stale writes and workspace switches',async()=>{
    const leases=await Promise.all([store.tryLease(new Date()),store.tryLease(new Date())]);
    expect(leases.filter(Boolean)).toHaveLength(1);const token=leases.find(Boolean)!;
    const input={provider:scope.provider,accountUid:scope.accountUid,regionId:'cn-hangzhou',resource:{type:'ecs' as const,id:'i-original'},
      rangeInstanceId:null,status:'unverified' as const,reason:'fixture',evidence:{},now:new Date(),leaseToken:token};
    await runInCloudWorkspace(scope,()=>store.observe(input));
    await runInCloudWorkspace(scope,()=>expect(store.observe({...input,leaseToken:'stale'})).rejects.toThrow('租约'));
    await runInSystemCloudWorkspaceScope(()=>prisma.platformUser.update({where:{id:manager},data:{selectedCloudWorkspaceId:null}}));
    await runInCloudWorkspace(scope,()=>expect(store.observe(input)).rejects.toThrow('租约'));
    await runInSystemCloudWorkspaceScope(()=>prisma.platformUser.update({where:{id:manager},data:{selectedCloudWorkspaceId:workspace}}));
    await store.finish(token,new Date(),['cn-hangzhou'],null,workspace);
  });
  it('atomically queues one frozen destroy even with different idempotency keys, preserving historical jobs',async()=>{
    await runInCloudWorkspace(scope,async()=>{
      const instance=await prisma.rangeInstance.create({data:{name:'leftovers',status:'destroyed',instanceMode:'range',cloudProvider:'alibaba_cloud'}});
      const source=await prisma.provisionJob.create({data:{rangeInstanceId:instance.id,jobType:'create',status:'failed',triggeredBy:manager,
        startedAt:new Date(),finishedAt:new Date()}});
      const current=await prisma.rangeInstance.update({where:{id:instance.id},data:{lastJobId:source.id}});
      await store.observe({provider:scope.provider,accountUid:scope.accountUid,regionId:'cn-hangzhou',resource:{type:'ecs',id:'i-reclaim'},
        rangeInstanceId:instance.id,status:'pending',reason:'fixture',evidence:{recordedInventory:true,sourceJobIds:[source.id],accountVerified:true},now:new Date()});
      const alert=(await store.list()).find(row=>row.resourceId==='i-reclaim')!;
      const input={alert,instance:current as any,summary:{mode:'opentofu' as const,executionContext:{provider:'alibaba_cloud' as const,
        cloudAccountUid:scope.accountUid,cloudAccountContextId:'context-original',regionId:'cn-hangzhou',zoneId:'cn-hangzhou-j'},hostIds:{node:'i-reclaim'}},
        resources:[{type:'ecs' as const,id:'i-reclaim'}],planDigest:'a'.repeat(64),idempotencyKey:'first',actorUserId:manager};
      const results=await Promise.allSettled([store.queueReclaim(input),store.queueReclaim({...input,idempotencyKey:'different'})]);
      expect(results.some(result=>result.status==='fulfilled')).toBe(true);
      expect(await prisma.provisionJob.count({where:{rangeInstanceId:instance.id,jobType:'destroy'}})).toBe(1);
      expect(await prisma.provisionJob.findUnique({where:{id:source.id}})).toMatchObject({status:'failed'});
      expect(await store.get(alert.id)).toMatchObject({status:'reclaiming',remainingResources:[{type:'ecs',id:'i-reclaim'}]});
      expect(await prisma.rangeInstance.findUnique({where:{id:instance.id}})).toMatchObject({status:'pending_destroy',
        resourceSummary:{executionContext:{cloudAccountUid:scope.accountUid,cloudAccountContextId:'context-original'}}});
    });
  });
  it('refuses an admitted cleanup if another resource operation became active before atomic intake',async()=>{
    await runInCloudWorkspace(scope,async()=>{
      const instance=await prisma.rangeInstance.create({data:{name:'race',status:'destroyed',instanceMode:'range',cloudProvider:'alibaba_cloud'}});
      await store.observe({provider:scope.provider,accountUid:scope.accountUid,regionId:'cn-hangzhou',resource:{type:'ecs',id:'i-race'},
        rangeInstanceId:instance.id,status:'pending',reason:'fixture',evidence:{recordedInventory:true,sourceJobIds:[],accountVerified:true},now:new Date()});
      const alert=(await store.list()).find(row=>row.resourceId==='i-race')!;
      await prisma.provisionJob.create({data:{rangeInstanceId:instance.id,jobType:'create',triggeredBy:manager,status:'pending'}});
      await expect(store.queueReclaim({alert,instance:instance as any,summary:{mode:'opentofu'},resources:[{type:'ecs',id:'i-race'}],
        planDigest:'b'.repeat(64),idempotencyKey:'race',actorUserId:manager})).rejects.toThrow('作业已变化');
      expect(await prisma.provisionJob.count({where:{rangeInstanceId:instance.id,jobType:'destroy'}})).toBe(0);
    });
  });
});
