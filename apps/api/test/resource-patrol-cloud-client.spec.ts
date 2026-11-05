import { ResourcePatrolCloudClient } from '../src/admin/resource-patrol-cloud-client';
import { setTimeout as sleep } from 'node:timers/promises';
import { AliyunVpcReadPacingService } from '../src/admin/aliyun-vpc-read-pacing.service';
jest.mock('node:timers/promises',()=>({setTimeout:jest.fn(async()=>undefined)}));

const account = { provider:'alibaba_cloud' as const,cloudAccountContextId:'ctx-a',accountUid:'1000001',accountUidResolved:true,
  defaultRegion:'cn-hangzhou',defaultZoneId:'cn-hangzhou-j',accessKeyId:'fixture-ak',accessKeySecret:'fixture-sk',imageImportBucket:'' };
const response=(value: unknown,status=200)=>({ok:status===200,status,json:async()=>value}) as Response;
describe('resource patrol bounded cloud reads',()=>{
  const original=global.fetch;
  beforeEach(()=>jest.mocked(sleep).mockReset().mockResolvedValue(undefined));
  afterEach(()=>{global.fetch=original;});
  it('rejects a cloud identity mismatch before any deletion can be admitted',async()=>{
    global.fetch=jest.fn(async()=>response({AccountId:'1000002',RequestId:'identity'}));
    await expect(new ResourcePatrolCloudClient().verifyAccount(account)).rejects.toThrow('IDENTITY_MISMATCH');
  });
  it('backs off throttled reads with fresh request nonces while preserving the exact filter',async()=>{
    global.fetch=jest.fn()
      .mockResolvedValueOnce(response({Code:'Throttling.User',RequestId:'limited'},400))
      .mockResolvedValueOnce(response({RequestId:'acl-success',TotalCount:0,NetworkAcls:{NetworkAcl:[]}}));
    await expect((new ResourcePatrolCloudClient() as any).list(account,'network_acl',['acl-original'])).resolves.toEqual([]);
    const queries=(global.fetch as jest.Mock).mock.calls.map(([url])=>new URL(String(url)).searchParams);
    expect(queries).toHaveLength(2);
    expect(queries.every(query=>query.get('NetworkAclId')==='acl-original')).toBe(true);
    expect(queries[0].get('SignatureNonce')).not.toBe(queries[1].get('SignatureNonce'));
  });
  it('bounds persistent read throttling and retains failure instead of reporting absence',async()=>{
    global.fetch=jest.fn(async()=>response({Code:'Throttling.User',RequestId:'limited'},400));
    await expect((new ResourcePatrolCloudClient() as any).list(account,'network_acl',['acl-original'])).rejects.toMatchObject({code:'Throttling.User'});
    expect(global.fetch).toHaveBeenCalledTimes(6);
  },15000);
  it('paces consecutive exact ACL reads without removing the original ID filters',async()=>{
    global.fetch=jest.fn(async()=>response({RequestId:'paced-acl',TotalCount:0,NetworkAcls:{NetworkAcl:[]}}));
    await expect((new ResourcePatrolCloudClient() as any).list(account,'network_acl',['acl-one','acl-two'])).resolves.toEqual([]);
    expect(jest.mocked(sleep).mock.calls.some(([ms])=>Number(ms)>1000&&Number(ms)<=3000)).toBe(true);
    expect((global.fetch as jest.Mock).mock.calls.map(([url])=>new URL(String(url)).searchParams.get('NetworkAclId'))).toEqual(['acl-one','acl-two']);
  });
  it('shares the VPC read budget across different Describe APIs for the same account',async()=>{
    const cloud:any=new ResourcePatrolCloudClient();
    global.fetch=jest.fn(async(url:any)=>response({RequestId:'shared-read',TotalCount:0,...(new URL(String(url)).searchParams.get('Action')==='DescribeVpcs'?{Vpcs:{Vpc:[]}}:{NetworkAcls:{NetworkAcl:[]}})}));
    await cloud.list(account,'vpc',['vpc-original']);
    await cloud.list(account,'network_acl',['acl-original']);
    expect(jest.mocked(sleep).mock.calls.some(([ms])=>Number(ms)>0)).toBe(true);
  });
  it('never automatically retries a throttled deletion',async()=>{
    global.fetch=jest.fn(async()=>response({Code:'Throttling.User',RequestId:'limited-write'},400));
    await expect(new ResourcePatrolCloudClient().mutate(account,'vpc','DeleteNetworkAcl',{NetworkAclId:'acl-original'})).rejects.toMatchObject({code:'Throttling.User'});
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('shares provider Retry-After cooldown without changing the original filters or retrying permissions',async()=>{
    const pacing={wait:jest.fn(async()=>undefined),cooldown:jest.fn(async()=>undefined)};
    const cloud:any=new ResourcePatrolCloudClient(pacing as unknown as AliyunVpcReadPacingService);
    global.fetch=jest.fn().mockResolvedValueOnce({...response({Code:'Throttling.User',RequestId:'limited'},400),headers:new Headers({'retry-after':'12'})})
      .mockResolvedValueOnce(response({RequestId:'read-ok',TotalCount:0,NetworkAcls:{NetworkAcl:[]}}));
    await cloud.list(account,'network_acl',['acl-original']);
    expect(pacing.cooldown).toHaveBeenCalledWith(account.accountUid,12000);
    expect(pacing.wait).toHaveBeenCalledTimes(2);
    global.fetch=jest.fn(async()=>response({Code:'Forbidden.RAM',RequestId:'denied'},403));
    await expect(cloud.list(account,'network_acl',['acl-original'])).rejects.toMatchObject({code:'Forbidden.RAM'});
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not sleep beyond the total retry budget or retry a throttle without an official receipt',async()=>{
    global.fetch=jest.fn(async()=>({...response({Code:'Throttling.User',RequestId:'limited'},400),headers:new Headers({'retry-after':'180'})}));
    await expect((new ResourcePatrolCloudClient() as any).list(account,'network_acl',['acl-original'])).rejects.toMatchObject({attempts:1});
    expect(global.fetch).toHaveBeenCalledTimes(1);
    global.fetch=jest.fn(async()=>response({Code:'Throttling.User'},400));
    await expect((new ResourcePatrolCloudClient() as any).list(account,'network_acl',['acl-original'])).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([true,false])('deduplicates shared VPCs and skips only ACLs already present in complete parent inventory: %s',async present=>{
    const cloud:any=new ResourcePatrolCloudClient();
    const vpc={type:'vpc',id:'vpc-shared',tags:{},parentId:null,attachedInstanceId:null,systemDisk:false,raw:{}};
    const acl={...vpc,type:'network_acl',id:'acl-present',parentId:'vpc-shared'};
    const list=jest.spyOn(cloud,'list').mockImplementation(async(_account:any,type:any,ids:any)=>type==='vpc'&&ids?.length?[vpc]:[]);
    const ali=jest.spyOn(cloud,'aliList').mockImplementation(async(_account:any,type:any,parameters:any)=>type==='network_acl'&&parameters.VpcId&&present?[acl]:[]);
    await cloud.inspect(account,[{type:'vpc',id:'vpc-shared'},{type:'vpc',id:'vpc-shared'},{type:'network_acl',id:'acl-present'},{type:'network_acl',id:'acl-missing'}]);
    expect(ali.mock.calls.filter((args:any)=>args[1]==='network_acl')).toHaveLength(1);
    expect(list.mock.calls.filter((args:any)=>args[1]==='network_acl').map((args:any)=>args[2])).toEqual([present?['acl-missing']:['acl-present','acl-missing']]);
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
  it.each(['raw\nprivate content',account.accessKeyId,account.accessKeySecret])('does not copy malformed or credential-bearing cloud codes into diagnostics: %j',async code=>{
    global.fetch=jest.fn(async()=>response({Code:code,RequestId:'safe-request',Message:'private full cloud error'},400));
    await expect(new ResourcePatrolCloudClient().verifyAccount(account)).rejects.toMatchObject({
      action:'GetCallerIdentity',status:400,code:'UNKNOWN',requestId:'safe-request',
    });
  });
  it.each([
    {TotalCount:2,RequestId:'page',Instances:{Instance:null}},
    {TotalCount:0,RequestId:'page',NextToken:'next',Instances:{Instance:[]}},
    {TotalCount:1,RequestId:'page',Instances:{Instance:[{InstanceId:'i-unrequested'}]}},
  ])('rejects incomplete pagination and unrequested identities: %j',async payload=>{
    global.fetch=jest.fn(async()=>response(payload));
    await expect((new ResourcePatrolCloudClient() as any).list(account,'ecs',['i-original'])).rejects.toThrow();
  });
  it('retains the failing API receipt and safe pagination shape, not the raw response',async()=>{
    global.fetch=jest.fn(async()=>response({RequestId:'safe-page',TotalCount:1,NextToken:'private-cursor',
      Instances:{Instance:[]},Message:'private vendor text'}));
    await expect((new ResourcePatrolCloudClient() as any).aliList(account,'ecs',{})).rejects.toMatchObject({
      action:'DescribeInstances',status:200,code:'INCOMPLETE_RESOURCE_PAGINATION',requestId:'safe-page',
      pagination:{page:1,totalCount:1,rowCount:0,hasNextToken:true},
    });
  });
  it('rejects duplicate tags rather than letting a copied marker prove ownership',async()=>{
    global.fetch=jest.fn(async()=>response({TotalCount:1,RequestId:'page',Instances:{Instance:[{InstanceId:'i-original',Tags:{Tag:[
      {TagKey:'CreatedBy',TagValue:'cyber-range-platform'},{TagKey:'CreatedBy',TagValue:'external'},
    ]}}]}}));
    await expect((new ResourcePatrolCloudClient() as any).list(account,'ecs',['i-original'])).rejects.toThrow('TAG');
  });
  it('uses security-group cursor pagination and reads even a short page with a next token',async()=>{
    global.fetch=jest.fn(async(url:any)=>{
      const params=new URL(String(url)).searchParams;
      expect(params.get('MaxResults')).toBe('100');
      expect(params.has('PageSize')).toBe(false);
      expect(params.has('PageNumber')).toBe(false);
      const page=params.has('NextToken')?2:1;
      return response({RequestId:'sg-page',NextToken:page===1?'sg-next':'',SecurityGroups:{SecurityGroup:Array.from({length:page===1?50:1},(_,index)=>({SecurityGroupId:`sg-${page}-${index}`}))}});
    });
    expect(await (new ResourcePatrolCloudClient() as any).aliList(account,'security_group',{})).toHaveLength(51);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['ecs','DescribeInstances','Instances','Instance','InstanceId'],
    ['disk','DescribeDisks','Disks','Disk','DiskId'],
  ])('reads every %s cursor page despite meaningless or changing totals',async(type,action,container,setKey,idKey)=>{
    global.fetch=jest.fn(async(url:any)=>{
      const params=new URL(String(url)).searchParams,second=params.has('NextToken');
      expect(params.get('Action')).toBe(action);expect(params.get('MaxResults')).toBe('100');
      expect(params.has('PageNumber')).toBe(false);expect(params.has('PageSize')).toBe(false);
      if(second)expect(params.get('NextToken')).toBe('private-next-cursor');
      return response({RequestId:'cursor-page',TotalCount:second?0:96,NextToken:second?'':'private-next-cursor',
        [container]:{[setKey]:Array.from({length:second?46:50},(_,i)=>({[idKey]:`${type}-${second?i+50:i}`,Type:'system'}))}});
    });
    expect(await (new ResourcePatrolCloudClient() as any).aliList(account,type,{})).toHaveLength(96);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['repeated-id','repeated-token','empty-middle','bad-token','missing-set','missing-request-id','bound'])('fails closed for invalid ECS cursor reads: %s',async mode=>{
    let page=0;
    global.fetch=jest.fn(async()=>{
      page++;
      return response({RequestId:mode==='missing-request-id'?undefined:'cursor-page',TotalCount:0,
        NextToken:mode==='bad-token'?123:mode==='repeated-token'?'same':`next-${page}`,
        Instances:mode==='missing-set'?{}:{Instance:mode==='empty-middle'?[]:[{InstanceId:mode==='repeated-id'?'i-same':`i-${page}`}]}});
    });
    await expect((new ResourcePatrolCloudClient() as any).aliList(account,'ecs',{})).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(mode==='bound'?100:['repeated-id','repeated-token'].includes(mode)?2:1);
  });
  it('accepts documented decimal-string ACL counts without weakening completeness checks',async()=>{
    global.fetch=jest.fn(async(url:any)=>{
      const page=new URL(String(url)).searchParams.get('PageNumber');
      return response({RequestId:'acl-page',TotalCount:page==='1'?'2':2,NetworkAcls:{NetworkAcl:[{NetworkAclId:`acl-${page}`} ]}});
    });
    expect(await (new ResourcePatrolCloudClient() as any).aliList(account,'network_acl',{})).toHaveLength(2);
  });
  it.each(['', ' ', '1.0', '+1','1e0','9007199254740992','-1'])('rejects malformed or unsafe TotalCount %j',async count=>{
    global.fetch=jest.fn(async()=>response({RequestId:'acl-page',TotalCount:count,NetworkAcls:{NetworkAcl:[]}}));
    await expect((new ResourcePatrolCloudClient() as any).aliList(account,'network_acl',{})).rejects.toThrow('PAGINATION');
  });
  it.each(['alibaba_cloud','tencent_cloud'] as const)('requires a valid RequestId before returning a %s deletion receipt',async provider=>{
    for(const id of [undefined,null,123,'','bad\nvalue',account.accessKeyId]) {
      global.fetch=jest.fn(async()=>response(provider==='tencent_cloud'?{Response:{RequestId:id}}:{RequestId:id}));
      await expect(new ResourcePatrolCloudClient().mutate({...account,provider},provider==='tencent_cloud'?'cvm':'ecs',provider==='tencent_cloud'?'TerminateInstances':'DeleteInstances',{})).rejects.toThrow();
    }
    global.fetch=jest.fn(async()=>response(provider==='tencent_cloud'?{Response:{RequestId:'safe-request'}}:{RequestId:'safe-request'}));
    await expect(new ResourcePatrolCloudClient().mutate({...account,provider},provider==='tencent_cloud'?'cvm':'ecs',provider==='tencent_cloud'?'TerminateInstances':'DeleteInstances',{})).resolves.toEqual({requestId:'safe-request'});
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
  it('accepts the documented exact ENI absence code but not a missing parent or credentials',async()=>{
    global.fetch=jest.fn(async(url:any)=>{
      expect(new URL(String(url)).searchParams.get('NetworkInterfaceId.1')).toBe('eni-original');
      return response({RequestId:'exact-eni',Code:'InvalidEniId.NotFound'},404);
    });
    await expect((new ResourcePatrolCloudClient() as any).list(account,'eni',['eni-original'])).resolves.toEqual([]);
    for(const code of ['InvalidVpcId.NotFound','InvalidAccessKeyId.NotFound']) {
      global.fetch=jest.fn(async()=>response({RequestId:'wrong-source',Code:code},404));
      await expect((new ResourcePatrolCloudClient() as any).list(account,'eni',['eni-original'])).rejects.toThrow();
    }
  });
  it('does not traverse a released VPC but still checks every recorded child exact ID',async()=>{
    const sets:Record<string,Record<string,unknown>>={
      DescribeInstances:{Instances:{Instance:[]}},DescribeDisks:{Disks:{Disk:[]}},
      DescribeEipAddresses:{EipAddresses:{EipAddress:[]}},DescribeNatGateways:{NatGateways:{NatGateway:[]}},
      DescribeNetworkInterfaces:{NetworkInterfaceSets:{NetworkInterfaceSet:[]},NextToken:''},
      DescribeVpcs:{Vpcs:{Vpc:[]}},DescribeVSwitches:{VSwitches:{VSwitch:[]}},
      DescribeSecurityGroups:{SecurityGroups:{SecurityGroup:[]}},
    };
    global.fetch=jest.fn(async(url:any)=>{
      const query=new URL(String(url)).searchParams,action=query.get('Action')!;
      expect(query.has('VpcId') && action!=='DescribeVpcs').toBe(false);
      if(action==='DescribeVSwitches' && query.get('VSwitchId')==='vsw-remaining') {
        return response({RequestId:'child-exact',TotalCount:1,VSwitches:{VSwitch:[{VSwitchId:'vsw-remaining',VpcId:'vpc-released'}]}});
      }
      expect(sets[action]).toBeDefined();
      return response({RequestId:'bounded-read',TotalCount:0,...sets[action]});
    });
    const found=await new ResourcePatrolCloudClient().inspect(account,[{type:'vpc',id:'vpc-released'},{type:'vswitch',id:'vsw-remaining'}]);
    expect(found).toEqual([expect.objectContaining({type:'vswitch',id:'vsw-remaining'})]);
    expect((global.fetch as jest.Mock).mock.calls.some(([url])=>new URL(String(url)).searchParams.get('VSwitchId')==='vsw-remaining')).toBe(true);
  });
  it('does not treat conflicting tagged and exact VPC observations as a completed check',async()=>{
    const service=new ResourcePatrolCloudClient();
    jest.spyOn(service as any,'list').mockImplementation(async(...args:unknown[])=>{
      const [,type,ids]=args;
      return type==='vpc' && !ids ? [{type:'vpc',id:'vpc-original',tags:{},raw:{},systemDisk:false,parentId:null,attachedInstanceId:null}] : [];
    });
    await expect(service.inspect(account,[{type:'vpc',id:'vpc-original'}])).rejects.toThrow('INCONSISTENT_PARENT_RESOURCE_LOOKUP');
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
  it.each([0,'0',99])('ignores the documented meaningless ENI TotalCount %j in token pagination',async total=>{
    global.fetch=jest.fn(async(url:any)=>{
      const params=new URL(String(url)).searchParams;
      expect(params.get('MaxResults')).toBe('100');
      expect(params.has('PageNumber')).toBe(false);
      return response({RequestId:'eni-token-page',TotalCount:total,NextToken:'',
        NetworkInterfaceSets:{NetworkInterfaceSet:[{NetworkInterfaceId:'eni-original'}]}});
    });
    await expect((new ResourcePatrolCloudClient() as any).list(account,'eni',['eni-original'])).resolves.toEqual([
      expect.objectContaining({type:'eni',id:'eni-original'}),
    ]);
  });
  it('finishes every ENI token page even when legacy totals change between pages',async()=>{
    global.fetch=jest.fn(async(url:any)=>{
      const next=new URL(String(url)).searchParams.get('NextToken');
      return response({RequestId:'eni-token-page',TotalCount:next?0:1000,NextToken:next?'':'next',
        NetworkInterfaceSets:{NetworkInterfaceSet:[{NetworkInterfaceId:next?'eni-last':'eni-first'}]}});
    });
    const rows=await (new ResourcePatrolCloudClient() as any).aliList(account,'eni',{});
    expect(rows.map((row:any)=>row.id)).toEqual(['eni-first','eni-last']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    {},
    {NetworkInterfaceSets:{NetworkInterfaceSet:[]},NextToken:'next'},
    {NetworkInterfaceSets:{NetworkInterfaceSet:[{NetworkInterfaceId:'eni-first'}]},NextToken:123},
    {NetworkInterfaceSets:{NetworkInterfaceSet:[{NetworkInterfaceId:'eni-first'},{NetworkInterfaceId:'eni-first'}]}},
    {NetworkInterfaceSets:{NetworkInterfaceSet:[{NetworkInterfaceId:' '}]}},
    {NetworkInterfaceSets:{NetworkInterfaceSet:Array.from({length:101},(_,i)=>({NetworkInterfaceId:`eni-${i}`}))}},
  ])('still rejects incomplete or malformed ENI token pages: %j',async payload=>{
    global.fetch=jest.fn(async()=>response({RequestId:'eni-invalid-page',TotalCount:0,...payload}));
    await expect((new ResourcePatrolCloudClient() as any).aliList(account,'eni',{})).rejects.toMatchObject({action:'DescribeNetworkInterfaces'});
  });
  it('retains the ENI page bound when every cursor is different',async()=>{
    let page=0;
    global.fetch=jest.fn(async()=>response({RequestId:'eni-bound',TotalCount:0,NextToken:`next-${++page}`,
      NetworkInterfaceSets:{NetworkInterfaceSet:[{NetworkInterfaceId:`eni-${page}`}]}}));
    await expect((new ResourcePatrolCloudClient() as any).aliList(account,'eni',{})).rejects.toThrow('ENI_PAGINATION_LIMIT');
    expect(global.fetch).toHaveBeenCalledTimes(100);
  });
});
