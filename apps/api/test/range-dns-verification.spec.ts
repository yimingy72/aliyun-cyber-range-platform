import { RangeDnsVerificationService, parseDnsReadback, deployedDnsPolicy } from '../src/admin/range-dns-verification.service';
import { assertExistingHostBootstrapUnchanged } from '../src/admin/range-instances.service';
const dns = { servers: ['10.1.0.10'], nicIds: ['nic-2'], domain: 'ad.example' };
const host = { id: 'win', kind: 'ecs', dns, initScript: '', nics: [{ id: 'nic-1', privateIp: '10.1.0.20', switchId: 'sw' }, { id: 'nic-2', privateIp: '10.2.0.20', switchId: 'sw2' }] };
const expected = [{ nicId: 'nic-2', privateIp: '10.2.0.20', servers: dns.servers }];
const observed = [{nicId:'nic-1',privateIp:'10.1.0.20',interfaceIndex:6,actualServers:['100.100.2.136']},{nicId:'nic-2',privateIp:'10.2.0.20',interfaceIndex:7,actualServers:dns.servers}];
const report = (nonce: string, patch: any = {}) => 'CYBER_RANGE_DNS_RESULT:' + JSON.stringify({schemaVersion:1, verificationNonce:nonce, status:'verified', method:'ad_srv', interfaces:[{ ...expected[0], expectedServers:dns.servers, actualServers:dns.servers, interfaceIndex:7, matched:true }], observedInterfaces:[{nicId:expected[0].nicId,privateIp:expected[0].privateIp,interfaceIndex:7,actualServers:dns.servers}], probes:[{server:dns.servers[0], status:'verified',recordCount:1}], ...patch});
function setup() {
  const range: any = { id:'r', instanceMode:'range', status:'running', ownerUserId:'u', runtimeTopologyGraph:{nodes:[structuredClone(host)]}, resourceSummary:{mode:'opentofu',hostIds:{win:'i-owned'}, executionContext:{cloudAccountContextId:'ctx'}} };
  const repo: any = { getRangeInstanceById:jest.fn(async()=>range), listProvisionJobs:jest.fn(async()=>[]), getProvisionJobById:jest.fn(async()=>({status:'running',rangeInstanceId:'r'})), updateRangeInstanceDnsState:jest.fn(async(_id,key,native,claim,entry)=>{
    if(range.status!=='running'||range.resourceSummary.hostIds[key]!==native||(range.resourceSummary.dnsVerification?.[key]?.claimId??null)!==claim)return false;
    range.resourceSummary.dnsVerification={...range.resourceSummary.dnsVerification,[key]:entry};return true;
  }) };
  const client: any = {assertOwned:jest.fn(async()=>{}),submit:jest.fn(async()=>({invocationId:'inv-1',requestId:'req-1'})),read:jest.fn(async()=>({status:'success',exitCode:0,output:report(range.resourceSummary.dnsVerification.win.claimId,{observedInterfaces:observed})}))};
  const config: any = {getAccountContextById:jest.fn(async()=>({provider:'alibaba_cloud'}))};
  const service=new RangeDnsVerificationService(repo,config,client);
  return {range,repo,client,config,service};
}
describe('guest DNS verification is independent of cloud lifecycle',()=>{
 it('reads only the explicitly selected deployed secondary NIC',()=>expect(deployedDnsPolicy(setup().range,'win').expected).toEqual(expected));
 it('requires actual ordered readback and AD SRV evidence',()=>expect(parseDnsReadback(report('n'),'n',expected,dns.domain)).toMatchObject({status:'verified',resolutionStatus:'verified'}));
 it('rejects replayed reports',()=>expect(()=>parseDnsReadback(report('old'),'new',expected,dns.domain)).toThrow('MISMATCH'));
 it('rejects multiple private IPs mapped to the same guest NIC',()=>{const target=[...expected,{...expected[0],nicId:'nic-3',privateIp:'10.3.0.20'}];expect(()=>parseDnsReadback(report('n',{interfaces:target.map(nic=>({...nic,expectedServers:dns.servers,actualServers:dns.servers,interfaceIndex:7}))}),'n',target,dns.domain)).toThrow('MISMATCH');});
 it('does not trust forged verified/matched flags',()=>expect(parseDnsReadback(report('n',{interfaces:[{...expected[0],expectedServers:dns.servers,actualServers:['8.8.8.8'],interfaceIndex:7,matched:true}],observedInterfaces:[{...observed[1],actualServers:['8.8.8.8']}]}),'n',expected,dns.domain)).toMatchObject({status:'failed',errorCode:'DNS_READBACK_MISMATCH'}));
 it('marks NXDOMAIN as failed even if report claims verified',()=>expect(parseDnsReadback(report('n',{probes:[{server:dns.servers[0],status:'verified',recordCount:0}]}),'n',expected,dns.domain)).toMatchObject({status:'failed',resolutionStatus:'failed'}));
 it('without domain only claims readback verification',()=>expect(parseDnsReadback(report('n',{method:'readback',probes:[]}),'n',expected)).toMatchObject({status:'verified',resolutionStatus:'not_requested'}));
 it.each([{interfaces:[]},{interfaces:[{...expected[0],privateIp:'10.2.0.99',expectedServers:dns.servers,actualServers:dns.servers}]}])('rejects missing/wrong guest NIC identity %j',patch=>expect(()=>parseDnsReadback(report('n',patch),'n',expected,dns.domain)).toThrow());
 it('persists a safe result and original cloud receipt',async()=>{const t=setup();const r=await t.service.verify('r','win',{id:'u',role:'user'});expect(r.status).toBe('verified');expect(r.dnsVerification).not.toHaveProperty('claimId');expect(t.range.resourceSummary.dnsVerification.win.invocationId).toBe('inv-1');expect(t.client.submit).toHaveBeenCalledTimes(1);expect(t.range.status).toBe('running');});
 it('DNS failure never changes cloud status or creates a provision job',async()=>{const t=setup();t.client.read.mockResolvedValue({status:'success',exitCode:0,output:report('bad')});expect((await t.service.verify('r','win',{id:'u',role:'user'})).status).toBe('unverified');expect(t.range.status).toBe('running');expect(Object.keys(t.repo)).not.toContain('createProvisionJob');expect(t.client.submit).toHaveBeenCalledTimes(1);});
 it('ambiguous submission is not retried and errors do not expose secrets',async()=>{const t=setup();t.client.submit.mockRejectedValue(new Error('AK secret password'));const r=await t.service.verify('r','win',{id:'u',role:'user'});expect(r.dnsVerification.errorCode).toBe('DNS_AGENT_UNAVAILABLE');expect(t.client.submit).toHaveBeenCalledTimes(1);expect(t.range.status).toBe('running');});
 it('rejects a different owner before cloud requests',async()=>{const t=setup();await expect(t.service.verify('r','win',{id:'other',role:'user'})).rejects.toThrow('denied');expect(t.client.submit).not.toHaveBeenCalled();});
 it('rejects concurrent checks',async()=>{const t=setup();t.range.resourceSummary.dnsVerification={win:{status:'checking',claimId:'old',expiresAt:new Date(Date.now()+60000).toISOString()}};await expect(t.service.verify('r','win',{id:'u',role:'user'})).rejects.toThrow('正在');expect(t.client.submit).not.toHaveBeenCalled();});
 it('does not overwrite destroyed/moved host results',async()=>{const t=setup();t.client.read.mockImplementation(async()=>{t.range.status='destroying';return {status:'success',exitCode:0,output:report(t.range.resourceSummary.dnsVerification.win.claimId)};});await expect(t.service.verify('r','win',{id:'u',role:'user'})).rejects.toThrow('变化');expect(t.range.status).toBe('destroying');});
 it('uses frozen account and deployed graph instead of draft',async()=>{const t=setup();t.range.draftTopologyGraph={nodes:[{...host,dns:{servers:['8.8.8.8'],nicIds:['nic-1']}}]};await t.service.verify('r','win',{id:'u',role:'user'});expect(t.config.getAccountContextById).toHaveBeenCalledWith('ctx');expect(t.range.resourceSummary.dnsVerification.win.expected).toEqual(expected);});
 it('automatically checks only the completed current job and never waits in the cloud creation queue',async()=>{const t=setup();t.range.lastJobId='job';t.repo.getProvisionJobById.mockResolvedValue({status:'succeeded',rangeInstanceId:'r'});const verify=jest.spyOn(t.service,'verify');await t.service.verifyAll('r','job');expect(verify).toHaveBeenCalledTimes(1);t.range.lastJobId='new-job';await t.service.verifyAll('r','job');expect(verify).toHaveBeenCalledTimes(1);});
 it('shows interrupted guest checks as unverified without retrying cloud creation',()=>{const {publicDnsVerification}=require('../src/admin/range-dns-types');expect(publicDnsVerification({host:{status:'checking',expiresAt:'2000-01-01T00:00:00Z',expected,actual:[],method:'readback',resolutionStatus:'not_requested',claimId:'private'}}).host).toMatchObject({status:'unverified',errorCode:'DNS_COMMAND_INTERRUPTED'});});
 it('blocks active infrastructure operations',async()=>{const t=setup();t.repo.listProvisionJobs.mockResolvedValue([{id:'destroy',rangeInstanceId:'r',status:'pending'}]);await expect(t.service.verify('r','win',{id:'u',role:'user'})).rejects.toThrow('编排操作');expect(t.client.submit).not.toHaveBeenCalled();});
 it('rejects running guest bootstrap/DNS edits before apply can enqueue',()=>{const t=setup();expect(()=>assertExistingHostBootstrapUnchanged(t.range,{nodes:[{...host,dns:{...dns,servers:['10.1.0.11']}}]})).toThrow('不能');expect(()=>assertExistingHostBootstrapUnchanged(t.range,{nodes:[{...host,initScript:'new script'}]})).toThrow('不能');expect(()=>assertExistingHostBootstrapUnchanged(t.range,{nodes:[{...host,label:'safe label'}]})).not.toThrow();});
});


describe('all deployed NIC evidence and startup baseline preservation',()=>{
 const policy = ()=>deployedDnsPolicy(setup().range,'win');
 const fullReport=(patch:any={})=>{const p=policy();return report('n',{observedInterfaces:observed,baseline:{schemaVersion:1,policyHash:p.policyHash,interfaces:observed},...patch});};
 const parse=(patch:any={})=>{const p=policy();return parseDnsReadback(fullReport(patch),'n',p.expected,p.dns.domain,p.interfaces,p.policyHash);};
 it('observes all deployed NICs while selecting only the secondary NIC',()=>{expect(policy().interfaces).toHaveLength(2);expect(parse()).toMatchObject({status:'verified',preservationStatus:'verified',observedInterfaces:[{nicId:'nic-1',servers:['100.100.2.136']},{nicId:'nic-2',servers:dns.servers}],untouchedInterfaces:[{nicId:'nic-1',baselineServers:['100.100.2.136'],actualServers:['100.100.2.136']}]});});
 it('reports an unselected NIC DNS change independently of correct selected DNS',()=>expect(parse({observedInterfaces:[{...observed[0],actualServers:['8.8.8.8']},observed[1]]})).toMatchObject({status:'verified',preservationStatus:'changed',untouchedInterfaces:[{nicId:'nic-1',baselineServers:['100.100.2.136'],actualServers:['8.8.8.8']}]}));
 it.each([undefined,{schemaVersion:1,policyHash:'other',interfaces:observed},{schemaVersion:1,policyHash:policy().policyHash,interfaces:observed.slice(1)},{schemaVersion:1,policyHash:policy().policyHash,interfaces:[{...observed[0],actualServers:['not-an-ip']},observed[1]]},{schemaVersion:1,policyHash:policy().policyHash,interfaces:[{...observed[0],interfaceIndex:7},observed[1]]}])('never treats missing or contaminated baseline as preservation proof: %j',baseline=>expect(parse({baseline})).toMatchObject({status:'verified',preservationStatus:'unverified',untouchedInterfaces:[]}));
 it.each([undefined,observed.slice(1),[observed[0],observed[0]],[{...observed[0],interfaceIndex:7},observed[1]],[{...observed[0],privateIp:'10.1.0.99'},observed[1]],[{...observed[0],actualServers:['invalid']},observed[1]]])('rejects absent or mismatched fresh network observation: %j',observedInterfaces=>expect(()=>parse({observedInterfaces})).toThrow('MISMATCH'));
 it('rejects selected actual values inconsistent with the same fresh NIC observation',()=>expect(()=>parse({observedInterfaces:[observed[0],{...observed[1],actualServers:['8.8.8.8']}]})).toThrow('MISMATCH'));
 it('does not leak policy fingerprints or raw startup data',async()=>{const t=setup();const p=deployedDnsPolicy(t.range,'win');t.client.read.mockImplementation(async()=>({status:'success',exitCode:0,output:report(t.range.resourceSummary.dnsVerification.win.claimId,{observedInterfaces:observed,baseline:{schemaVersion:1,policyHash:p.policyHash,interfaces:observed,secret:'should-not-escape'}})}));const result=await t.service.verify('r','win',{id:'u',role:'user'});expect(result.dnsVerification.preservationStatus).toBe('verified');expect(JSON.stringify(result)).not.toContain('should-not-escape');expect(result.dnsVerification).not.toHaveProperty('policyHash');});
});

describe('controlled reapply of the deployed DNS policy', () => {
 function setupApply() {
  const t = setup(); let submitted = 0;
  const output = (nonce: string, configuration = false, patch: any = {}) => report(nonce, { method: configuration ? 'readback' : 'ad_srv', observedInterfaces: observed,
   baseline: { schemaVersion: 1, policyHash: deployedDnsPolicy(t.range, 'win').policyHash, interfaces: observed }, ...patch });
  t.client.submit.mockImplementation(async () => ({ invocationId: ++submitted === 1 ? 'inv-config' : 'inv-reader', requestId: `req-${submitted}` }));
  t.client.read.mockImplementation(async (_account: unknown, invocation: string) => ({ status: 'success', exitCode: 0, output: output(t.range.resourceSummary.dnsVerification.win.claimId, invocation === 'inv-config') }));
  return { ...t, output };
 }
 it('sets the fixed deployed secondary NIC, then independently reads DNS and AD SRV on the same native instance', async () => {
  const t = setupApply(); t.range.draftTopologyGraph = { nodes: [{ ...host, dns: { servers: ['8.8.8.8'], nicIds: ['nic-1'] } }] };
  const result = await t.service.verify('r', 'win', { id: 'u', role: 'user' }, undefined, true);
  expect(result).toMatchObject({ action: 'apply-dns', status: 'verified', dnsVerification: { preservationStatus: 'verified', resolutionStatus: 'verified' } });
  expect(t.client.submit).toHaveBeenCalledTimes(2); expect(t.client.read.mock.calls.map((call: any[]) => call[1])).toEqual(['inv-config', 'inv-reader']);
  const calls = t.client.submit.mock.calls; expect(calls.every((call: any[]) => call[1] === 'i-owned')).toBe(true); expect(calls[0][3]).toBe(calls[1][3]);
  expect(calls[0][2]).toContain('Set-DnsClientServerAddress'); expect(calls[1][2]).not.toContain('Set-DnsClientServerAddress');
  expect(t.range.status).toBe('running'); expect(Object.keys(t.repo)).not.toContain('createProvisionJob');
  expect(t.range.resourceSummary.dnsVerification.win).toMatchObject({ configurationInvocationId: 'inv-config', configurationRequestId: 'req-1', invocationId: 'inv-reader', cloudRequestId: 'req-2' });
  expect(JSON.stringify(result)).not.toContain('inv-config'); expect(JSON.stringify(result)).not.toContain('claimId');
  await t.service.verify('r', 'win', { id: 'u', role: 'user' });
  expect(t.range.resourceSummary.dnsVerification.win.configurationInvocationId).toBe('inv-config');
 });
 it('setter failure stops before another command and cannot enqueue a cloud retry', async () => {
  const t = setupApply(); t.client.read.mockImplementation(async () => ({ status: 'failed', exitCode: 1,
   output: t.output(t.range.resourceSummary.dnsVerification.win.claimId, true, { status: 'failed' }) }));
  expect(await t.service.verify('r', 'win', { id: 'u', role: 'user' }, undefined, true)).toMatchObject({ action: 'apply-dns', status: 'failed' });
  expect(t.client.submit).toHaveBeenCalledTimes(1); expect(t.range.status).toBe('running'); expect(t.range.resourceSummary.hostIds.win).toBe('i-owned');
 });
 it.each(['changed', 'missing'])('does not accept unverifiable preservation of unselected NICs: %s', async kind => {
  const t = setupApply(); t.client.read.mockImplementation(async () => ({ status: 'success', exitCode: 0,
   output: t.output(t.range.resourceSummary.dnsVerification.win.claimId, true, kind === 'changed' ? { observedInterfaces: [{ ...observed[0], actualServers: ['8.8.8.8'] }, observed[1]] } : { baseline: undefined }) }));
  const result = await t.service.verify('r', 'win', { id: 'u', role: 'user' }, undefined, true);
  expect(result).toMatchObject({ status: 'failed', dnsVerification: { errorCode: 'DNS_CONFIGURATION_PRESERVATION_FAILED' } }); expect(t.client.submit).toHaveBeenCalledTimes(1);
 });
 it('reports a later AD failure without reapplying DNS or rebuilding the machine', async () => {
  const t = setupApply(); t.client.read.mockImplementation(async (_account: unknown, invocation: string) => ({ status: 'success', exitCode: 0,
   output: t.output(t.range.resourceSummary.dnsVerification.win.claimId, invocation === 'inv-config', invocation === 'inv-reader' ? { probes: [{ server: dns.servers[0], status: 'failed', recordCount: 0 }], status: 'failed' } : {}) }));
  expect(await t.service.verify('r', 'win', { id: 'u', role: 'user' }, undefined, true)).toMatchObject({ status: 'failed', dnsVerification: { errorCode: 'DNS_AD_SRV_FAILED' } });
  expect(t.client.submit).toHaveBeenCalledTimes(2); expect(t.range.status).toBe('running'); expect(t.range.resourceSummary.hostIds.win).toBe('i-owned');
 });
 it('fails preservation if an unselected NIC drifts between setter and independent reader', async () => {
  const t = setupApply(); t.client.read.mockImplementation(async (_account: unknown, invocation: string) => ({ status: 'success', exitCode: 0,
   output: t.output(t.range.resourceSummary.dnsVerification.win.claimId, invocation === 'inv-config', invocation === 'inv-reader' ? { observedInterfaces: [{ ...observed[0], actualServers: ['8.8.8.8'] }, observed[1]] } : {}) }));
  expect(await t.service.verify('r', 'win', { id: 'u', role: 'user' }, undefined, true)).toMatchObject({ status: 'failed', dnsVerification: { errorCode: 'DNS_CONFIGURATION_PRESERVATION_FAILED', preservationStatus: 'changed' } });
  expect(t.client.submit).toHaveBeenCalledTimes(2); expect(t.range.status).toBe('running');
 });
 it('stops after an ambiguous setter receipt without retrying configuration', async () => {
  const t = setupApply(); t.client.submit.mockRejectedValue(new Error('unknown receipt private secret'));
  expect(await t.service.verify('r', 'win', { id: 'u', role: 'user' }, undefined, true)).toMatchObject({ status: 'unverified', dnsVerification: { errorCode: 'DNS_AGENT_UNAVAILABLE' } });
  expect(t.client.submit).toHaveBeenCalledTimes(1); expect(t.client.read).not.toHaveBeenCalled(); expect(t.range.status).toBe('running');
 });
 it('does not submit the reader after destruction starts', async () => {
  const t = setupApply(); t.client.read.mockImplementation(async () => { t.range.status = 'destroying'; return { status: 'success', exitCode: 0, output: t.output(t.range.resourceSummary.dnsVerification.win.claimId, true) }; });
  await expect(t.service.verify('r', 'win', { id: 'u', role: 'user' }, undefined, true)).rejects.toThrow('变化'); expect(t.client.submit).toHaveBeenCalledTimes(1); expect(t.range.status).toBe('destroying');
 });
});
