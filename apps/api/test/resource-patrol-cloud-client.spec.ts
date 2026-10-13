import { ResourcePatrolCloudClient } from '../src/admin/resource-patrol-cloud-client';

const account = { provider:'alibaba_cloud' as const,cloudAccountContextId:'ctx-a',accountUid:'1000001',accountUidResolved:true,
  defaultRegion:'cn-hangzhou',defaultZoneId:'cn-hangzhou-j',accessKeyId:'fixture-ak',accessKeySecret:'fixture-sk',imageImportBucket:'' };
const response=(value: unknown,status=200)=>({ok:status===200,status,json:async()=>value}) as Response;
describe('resource patrol bounded cloud reads',()=>{
  const original=global.fetch;
  afterEach(()=>{global.fetch=original;});
  it('rejects a cloud identity mismatch before any deletion can be admitted',async()=>{
    global.fetch=jest.fn(async()=>response({AccountId:'1000002',RequestId:'identity'}));
    await expect(new ResourcePatrolCloudClient().verifyAccount(account)).rejects.toThrow('IDENTITY_MISMATCH');
  });
  it('reads exact IDs independently of tags, accepts identified documented absence and never accepts permission failure',async()=>{
    const service=new ResourcePatrolCloudClient();
    global.fetch=jest.fn(async(url:any)=>{
      const q=new URL(String(url)).searchParams;
      expect(q.get('VpcId')).toBe('vpc-original');expect(q.has('Tag.1.Key')).toBe(false);
      return response({Code:'InvalidVpcID.NotFound',RequestId:'not-found'},404);
    });
    await expect((service as any).list(account,'vpc',['vpc-original'])).resolves.toEqual([]);
    global.fetch=jest.fn(async()=>response({Code:'Forbidden',RequestId:'forbidden'},403));
    await expect((service as any).list(account,'vpc',['vpc-original'])).rejects.toThrow();
    global.fetch=jest.fn(async()=>response({Code:'InvalidVpcID.NotFound'},404));
    await expect((service as any).list(account,'vpc',['vpc-original'])).rejects.toThrow();
  });
  it.each([
    {TotalCount:2,RequestId:'page',Instances:{Instance:[]}},
    {TotalCount:0,RequestId:'page',NextToken:'next',Instances:{Instance:[]}},
    {TotalCount:1,RequestId:'page',Instances:{Instance:[{InstanceId:'i-unrequested'}]}},
  ])('rejects incomplete pagination and unrequested identities: %j',async payload=>{
    global.fetch=jest.fn(async()=>response(payload));
    await expect((new ResourcePatrolCloudClient() as any).list(account,'ecs',['i-original'])).rejects.toThrow();
  });
  it('rejects duplicate tags rather than letting a copied marker prove ownership',async()=>{
    global.fetch=jest.fn(async()=>response({TotalCount:1,RequestId:'page',Instances:{Instance:[{InstanceId:'i-original',Tags:{Tag:[
      {TagKey:'CreatedBy',TagValue:'cyber-range-platform'},{TagKey:'CreatedBy',TagValue:'external'},
    ]}}]}}));
    await expect((new ResourcePatrolCloudClient() as any).list(account,'ecs',['i-original'])).rejects.toThrow('TAG');
  });
  it('queries Tencent SNAT by its documented gateway parameter and preserves the composite inventory ID',async()=>{
    const calls:any[]=[];
    global.fetch=jest.fn(async(_url:any,options:any)=>{
      const action=options.headers['X-TC-Action'],body=JSON.parse(options.body);calls.push({action,body});
      if(action==='DescribeNatGatewaySourceIpTranslationNatRules') return response({Response:{RequestId:'snat',TotalCount:1,
        SourceIpTranslationNatRuleSet:[{NatGatewayId:'nat-original',VpcId:'vpc-original',ResourceId:'subnet-original',ResourceType:'SUBNET'}]}});
      return response({Response:{RequestId:'dnat',TotalCount:0,NatGatewayDestinationIpPortTranslationNatRuleSet:[]}});
    });
    const result=await (new ResourcePatrolCloudClient() as any).natRules({...account,provider:'tencent_cloud',defaultRegion:'ap-nanjing'},
      {id:'nat-original',parentId:'vpc-original',raw:{}});
    expect(result).toEqual([expect.objectContaining({type:'snat_entry',id:'nat-original#subnet-original',parentId:'nat-original'})]);
    expect(calls.find(call=>call.action==='DescribeNatGatewaySourceIpTranslationNatRules').body).toMatchObject({NatGatewayId:'nat-original'});
  });
  it('does not mistake an exact known disk for absence when its usage type changes',async()=>{
    global.fetch=jest.fn(async()=>response({TotalCount:1,RequestId:'disk',Disks:{Disk:[{DiskId:'d-original',Type:'data'}]}}));
    await expect((new ResourcePatrolCloudClient() as any).list(account,'disk',['d-original'])).resolves.toEqual([
      expect.objectContaining({id:'d-original',type:'disk',systemDisk:false}),
    ]);
  });
  it('uses the indexed exact ENI parameter and supports the documented token response without TotalCount',async()=>{
    global.fetch=jest.fn(async(url:any)=>{
      const params=new URL(String(url)).searchParams;
      expect(params.get('NetworkInterfaceId.1')).toBe('eni-original');expect(params.has('NetworkInterfaceId')).toBe(false);
      expect(params.get('MaxResults')).toBe('100');expect(params.has('PageNumber')).toBe(false);
      return response({RequestId:'eni',NextToken:'',NetworkInterfaceSets:{NetworkInterfaceSet:[{NetworkInterfaceId:'eni-original'}]}});
    });
    await expect((new ResourcePatrolCloudClient() as any).list(account,'eni',['eni-original'])).resolves.toEqual([
      expect.objectContaining({type:'eni',id:'eni-original'}),
    ]);
  });
  it('reads every ENI token page and refuses repeated cursors instead of treating truncation as absence',async()=>{
    const service=new ResourcePatrolCloudClient();
    global.fetch=jest.fn(async(url:any)=>{
      const token=new URL(String(url)).searchParams.get('NextToken');
      return response({RequestId:'eni',NextToken:token?'':'next',NetworkInterfaceSets:{NetworkInterfaceSet:[{NetworkInterfaceId:token?'eni-second':'eni-first'}]}});
    });
    expect(await (service as any).aliList(account,'eni',{})).toHaveLength(2);
    global.fetch=jest.fn(async()=>response({RequestId:'eni',NextToken:'same',NetworkInterfaceSets:{NetworkInterfaceSet:[{NetworkInterfaceId:'eni-repeat'}]}}));
    await expect((service as any).aliList(account,'eni',{})).rejects.toThrow();
  });
});
