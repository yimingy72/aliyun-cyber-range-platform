import { PrismaService } from '../src/database/prisma.service';
import { ResourcePatrolRepository } from '../src/admin/resource-patrol.repository';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  it('backfills only same-provider bound workspace UID without granting old candidates creation proof',async()=>{
    await runInSystemCloudWorkspaceScope(async()=>{
      const unbound=`unbound-${randomUUID()}`;
      await prisma.cloudWorkspace.create({data:{id:unbound,provider:scope.provider,accountUid:null,displayName:'unbound fixture'}});
      const create=(cloudWorkspaceId:string,cloudProvider:'alibaba_cloud'|'tencent_cloud',resourceId:string,accountUid:string|null=null)=>
        prisma.cloudResourceDrift.create({data:{cloudWorkspaceId,cloudProvider,cloudResourceId:resourceId,cloudResourceType:'snapshot',regionId:'cn-hangzhou',
          accountUid,reason:'old candidate',lastSeenAt:new Date()}});
      const same=await create(workspace,scope.provider,'s-old'),mismatch=await create(workspace,'tencent_cloud','s-foreign-provider'),
        unknown=await create(unbound,scope.provider,'s-unbound'),existing=await create(workspace,scope.provider,'s-previous-uid','previous-uid');
      const sql=readFileSync(resolve(__dirname,'../../../packages/database/prisma/migrations/20261013020000_resource_patrol_legacy_identity/migration.sql'),'utf8');
      await prisma.$executeRawUnsafe(sql);await prisma.$executeRawUnsafe(sql);
      expect(await prisma.cloudResourceDrift.findUnique({where:{id:same.id}})).toMatchObject({accountUid:scope.accountUid,patrolStatus:'unverified',sourceEvidence:{},resolvedAt:null});
      for(const row of [mismatch,unknown])expect(await prisma.cloudResourceDrift.findUnique({where:{id:row.id}})).toMatchObject({accountUid:null,patrolStatus:'unverified'});
      expect(await prisma.cloudResourceDrift.findUnique({where:{id:existing.id}})).toMatchObject({accountUid:'previous-uid',sourceEvidence:{}});
    });
  });
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
  it('fences billing writes after a manager account switch and rejects a changed designated manager even in the same workspace',async()=>{
    const token=await store.tryLease(new Date());expect(token).toBeTruthy();
    await runInCloudWorkspace(scope,async()=>{
      const instance=await prisma.rangeInstance.create({data:{name:'billing fence',status:'destroyed',instanceMode:'range',cloudProvider:scope.provider}});
      const job=await prisma.provisionJob.create({data:{rangeInstanceId:instance.id,jobType:'create',status:'failed',triggeredBy:manager,startedAt:new Date()}});
      const current=await prisma.rangeInstance.update({where:{id:instance.id},data:{lastJobId:job.id}});
      const input={leaseToken:token!,instance:current as any,resource:{type:'ecs' as const,id:'i-billing'},sourceJobId:job.id,
        provider:scope.provider,accountUid:scope.accountUid,regionId:'cn-hangzhou',observedAt:new Date(),present:true};
      await runInSystemCloudWorkspaceScope(()=>prisma.platformUser.update({where:{id:manager},data:{selectedCloudWorkspaceId:null}}));
      await expect(store.reconcileBillingObservation(input)).rejects.toThrow('租约');
      expect(await prisma.billingLedgerResource.count({where:{rangeInstanceId:instance.id}})).toBe(0);
      await runInSystemCloudWorkspaceScope(()=>prisma.platformUser.update({where:{id:manager},data:{selectedCloudWorkspaceId:workspace}}));
      const replacement=`replacement-${randomUUID()}`;
      await runInSystemCloudWorkspaceScope(async()=>{
        await prisma.platformUser.create({data:{id:replacement,username:replacement,loginUsername:replacement,passwordHash:'fixture',
          role:'admin',status:'active',isPlatformManager:true,selectedCloudWorkspaceId:workspace}});
        await store.setManager(replacement);
      });
      await expect(store.reconcileBillingObservation(input)).rejects.toThrow('租约');
      await store.setManager(manager);
      await store.reconcileBillingObservation(input);
      expect(await prisma.billingLedgerResource.findFirst({where:{rangeInstanceId:instance.id}})).toMatchObject({sourceProvisionJobId:job.id,releasedAt:null});
    });
    await store.finish(token!,new Date(),[],null,workspace);
  });
  it('holds the designated manager row until the fenced write commits, so a concurrent switch cannot interleave',async()=>{
    const token=await store.tryLease(new Date());expect(token).toBeTruthy();
    let entered!:()=>void,finish!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
    const write=runInCloudWorkspace(scope,()=>(store as any).withScanLease(token,async()=>{entered();await gate;}));
    await ready;let switched=false;
    const change=runInSystemCloudWorkspaceScope(()=>prisma.platformUser.update({where:{id:manager},data:{selectedCloudWorkspaceId:null}})).then(()=>{switched=true;});
    try {await new Promise(resolve=>setTimeout(resolve,50));expect(switched).toBe(false);}
    finally {finish();await write;await change;}
    expect(switched).toBe(true);
    await runInSystemCloudWorkspaceScope(()=>prisma.platformUser.update({where:{id:manager},data:{selectedCloudWorkspaceId:workspace}}));
    await store.finish(token!,new Date(),[],null,workspace);
  });
  it('does not mark an unproven candidate linked to the same instance as reclaiming when it is outside the confirmed plan',async()=>{
    await runInCloudWorkspace(scope,async()=>{
      const instance=await prisma.rangeInstance.create({data:{name:'precise alert plan',status:'destroyed',instanceMode:'range',cloudProvider:scope.provider}});
      const source=await prisma.provisionJob.create({data:{rangeInstanceId:instance.id,jobType:'create',status:'failed',triggeredBy:manager,startedAt:new Date()}});
      const current=await prisma.rangeInstance.update({where:{id:instance.id},data:{lastJobId:source.id}});
      for (const [id,status] of [['i-confirmed','pending'],['i-unproven','unverified']] as const) await store.observe({provider:scope.provider,
        accountUid:scope.accountUid,regionId:'cn-hangzhou',resource:{type:'ecs',id},rangeInstanceId:instance.id,status,reason:'fixture',
        evidence:{recordedInventory:status==='pending',sourceJobIds:status==='pending'?[source.id]:[],accountVerified:true},now:new Date()});
      const rows=(await store.list()).filter(row=>row.rangeInstanceId===instance.id),alert=rows.find(row=>row.resourceId==='i-confirmed')!;
      await store.queueReclaim({alert,instance:current as any,summary:{mode:'opentofu',hostIds:{node:'i-confirmed'}},
        resources:[{type:'ecs',id:'i-confirmed'}],planDigest:'c'.repeat(64),idempotencyKey:'exact-plan',actorUserId:manager});
      expect(await store.get(alert.id)).toMatchObject({status:'reclaiming'});
      expect(await store.get(rows.find(row=>row.resourceId==='i-unproven')!.id)).toMatchObject({status:'unverified',jobId:null});
    });
  });
});
