import { PrismaService } from '../src/database/prisma.service';
import { AliyunVpcReadPacingService, VpcReadBudgetTimeout } from '../src/admin/aliyun-vpc-read-pacing.service';

const url=process.env.VPC_READ_PACING_TEST_DATABASE_URL;
if(url&&(new URL(url).hostname!=='vpc-read-pacing-postgres'||new URL(url).pathname!=='/vpc_read_pacing_test'))throw new Error('An isolated VPC pacing test database is required');
const database=url?describe:describe.skip;
database('cross-process VPC read pacing in PostgreSQL',()=>{
  let a:PrismaService,b:PrismaService,api:AliyunVpcReadPacingService,worker:AliyunVpcReadPacingService;
  beforeAll(async()=>{a=new PrismaService({datasources:{db:{url}}});b=new PrismaService({datasources:{db:{url}}});await Promise.all([a.$connect(),b.$connect()]);api=new AliyunVpcReadPacingService(a);worker=new AliyunVpcReadPacingService(b);});
  beforeEach(async()=>{await a.$executeRaw`DELETE FROM "CloudApiReadBudget"`;});
  afterAll(async()=>{await Promise.all([a?.$disconnect(),b?.$disconnect()]);});
  it('admits only one simultaneous read across independent API/worker clients',async()=>{
    const waits=await Promise.all([api.tryAcquire('12345','DescribeVpcs'),worker.tryAcquire('12345','DescribeNetworkAcls')]);
    expect(waits.filter(wait=>wait===0)).toHaveLength(1);expect(waits.some(wait=>wait>0)).toBe(true);
  });
  it('shares the ACL family budget and account-wide cooldown across clients and operations',async()=>{
    expect(await api.tryAcquire('12345','DescribeNetworkAcls')).toBe(0);
    await a.$executeRaw`UPDATE "CloudApiReadBudget" SET "nextAt"=to_timestamp(0) WHERE "key"='alibaba:vpc:12345:all'`;
    expect(await worker.tryAcquire('12345','DescribeNetworkAclAttributes')).toBeGreaterThan(2500);
    expect(await worker.tryAcquire('12345','DescribeVpcs')).toBe(0);
    await api.cooldown('12345',5000);
    expect(await worker.tryAcquire('12345','DescribeVSwitches')).toBeGreaterThan(4500);
  });
  it('isolates different cloud accounts and never shortens an existing cooldown',async()=>{
    await api.cooldown('12345',60000);await worker.cooldown('12345',5000);
    expect(await worker.tryAcquire('12345','DescribeVpcs')).toBeGreaterThan(58000);
    expect(await worker.tryAcquire('67890','DescribeVpcs')).toBe(0);
  });
  it('uses database time rather than a skewed application clock',async()=>{
    const clock=jest.spyOn(Date,'now').mockReturnValue(0);
    try{expect(await api.tryAcquire('12345','DescribeNetworkAcls')).toBe(0);expect(await worker.tryAcquire('12345','DescribeNetworkAcls')).toBeGreaterThan(2500);}finally{clock.mockRestore();}
  });
  it('rechecks a ready slot atomically instead of releasing a queued burst',async()=>{
    const results=await Promise.all(Array.from({length:8},(_,i)=>(i%2?api:worker).tryAcquire('12345','DescribeNetworkAcls')));
    expect(results.filter(delay=>delay===0)).toHaveLength(1);
  });
  it('bounds waiting without allowing a cloud request before the shared cooldown',async()=>{
    await api.cooldown('12345',5000);
    await expect(worker.wait('12345','DescribeVpcs',Date.now()+100)).rejects.toBeInstanceOf(VpcReadBudgetTimeout);
  });
});
