import { buildWindowsDnsUserData, buildWindowsDnsVerificationScript, WINDOWS_DNS_RESULT_PREFIX } from '../src/provisioning/renderers/guest-dns-scripts';
import { AlibabaCloudOpenTofuRenderer } from '../src/provisioning/renderers/alibaba-cloud-opentofu-renderer';
import type { EnterpriseProvisionPlan } from '../src/provisioning/enterprise-provision-plan';
import { renderTencentRangeVariables } from '../src/provisioning/renderers/tencent-cloud-range-renderer';

const base = { dns: { servers: ['10.0.1.10','10.0.2.10'], nicIds: ['nic-secondary'], domain: 'lab.example' }, interfaces: [{ nicId: 'nic-primary', privateIp: '10.0.1.20' },{ nicId: 'nic-secondary', privateIp: '10.0.2.20' }] };
describe('Windows host DNS startup and independent verification scripts', () => {
  it.each(['alicloud','tencent_cloud'] as const)('uses %s official wrapper once and runs DNS before user initialization', provider => {
    const content = buildWindowsDnsUserData({ ...base, provider, scripts: [{ type: 'shell', content: '[powershell]\nWrite-Output "USER_INITIALIZATION"' },{ type: 'powershell', content: '<powershell>\nWrite-Output "SECOND_SCRIPT"\n</powershell>' }] });
    expect(content.startsWith(provider === 'alicloud' ? '[powershell]\n' : '<powershell>\n')).toBe(true);
    expect(content.match(provider === 'alicloud' ? /\[powershell\]/g : /<powershell>/g)).toHaveLength(1);
    expect(content).toContain("nicId='nic-secondary';privateIp='10.0.2.20'");
    expect(content).toContain("nicId='nic-primary';privateIp='10.0.1.20'");
    expect(content.indexOf('Write-DnsBaseline $dnsResult.observedInterfaces')).toBeLessThan(content.indexOf('Set-DnsClientServerAddress -InterfaceIndex $adapter.index'));
    expect(content).toContain('Set-DnsClientServerAddress -InterfaceIndex $adapter.index');
    expect(content).toContain('SetDNSServerSearchOrder');
    expect(content).not.toContain('Set-NetIPAddress');
    expect(content).not.toContain('SetDefaultIPGateway');
    expect(content.indexOf("if ($dnsResult.status -ne 'verified') { throw")).toBeLessThan(content.indexOf('USER_INITIALIZATION'));
    expect(content).toContain("$dnsDomain = ''");
    expect(Buffer.byteLength(content)).toBeLessThan(16 * 1024);
  });
  it('queries the live NIC and each AD DNS resolver, binds an invocation nonce and never configures or trusts a saved result', () => {
    const content = buildWindowsDnsVerificationScript({ ...base, verificationNonce: '1234-nonce' });
    expect(content).toContain('Get-DnsClientServerAddress -InterfaceIndex $adapter.index');
    expect(content).toContain('foreach ($server in $dnsExpected)');
    expect(content).toContain('$udp.Client.ReceiveTimeout = 3000');
    expect(content).toContain('_ldap._tcp.dc._msdcs.');
    expect(content).toContain("method='ad_srv'");
    expect(content).toContain("verificationNonce='1234-nonce'");
    expect(content).toContain(WINDOWS_DNS_RESULT_PREFIX);
    expect(content).not.toContain('Set-DnsClientServerAddress -InterfaceIndex');
    expect(content).not.toContain('.SetDNSServerSearchOrder(');
    expect(content).not.toContain('dns-result.json');
    expect(content).toContain('$dnsResult.baseline = Read-DnsBaseline');
    expect(content).toContain('observedInterfaces=@()');
  });
  it('reports readback only without an AD domain', () => expect(buildWindowsDnsVerificationScript({ ...base, dns: { ...base.dns, domain: undefined } })).toContain("method='readback'"));
  it.each([
    { servers: ['10.0.1.10;whoami'], nicIds: ['nic-secondary'] },
    { servers: ['10.0.1.10','10.0.1.10'], nicIds: ['nic-secondary'] },
    { servers: ['10.0.1.10'], nicIds: ['missing'] },
    { servers: ['10.0.1.10'], nicIds: ['nic-secondary','nic-secondary'] },
    { servers: ['10.0.1.10'], nicIds: ['nic-secondary'], domain: "lab.example';whoami" },
  ])('rejects invalid configuration before creating a guest payload: %j', dns => expect(() => buildWindowsDnsUserData({ ...base, dns, provider: 'alicloud', scripts: [] })).toThrow());
  it.each(['#!/bin/bash\necho bad','#cloud-config\nruncmd: []','[bat]\necho bad','[powershell]\nWrite-Output ok\n[powershell]\nWrite-Output duplicate','<powershell>\nWrite-Output bad'])('rejects unsupported and mixed Windows user script %s', content => expect(() => buildWindowsDnsUserData({ ...base, provider: 'alicloud', scripts: [{ type: 'shell', content }] })).toThrow());
  it('rejects oversized UTF-8 userdata using the vendor limit', () => {
    expect(() => buildWindowsDnsUserData({ ...base, provider: 'tencent_cloud', scripts: [{ type: 'powershell', content: '# ' + '中'.repeat(6000) }] })).toThrow('16 KiB');
    expect(() => buildWindowsDnsUserData({ ...base, provider: 'alicloud', scripts: [{ type: 'powershell', content: '# ' + '中'.repeat(12000) }] })).toThrow('32 KiB');
  });
  it('merges per-host DNS with shared initialization without changing a non-DNS host payload', () => {
    const plan = { resourceNamePrefix: 'fixture', entryHostKey: 'h1', network: { vpcCidr: '10.0.0.0/16', secondaryVpcCidrs: [], dmzCidr: '', officeCidr: '', serverCidr: '' }, networkZones: [],
      hostDefinitions: [{ key: 'h1', name: 'Member', hostName: null, zoneKey: 'z', privateIp: '10.0.1.20', dns: base.dns },{ key: 'h2', name: 'Other', hostName: null, zoneKey: 'z', privateIp: '10.0.1.21' }],
      hostNetworkInterfaces: [{ hostKey: 'h1', interfaces: [{ nicId: 'nic-secondary', deviceIndex: 0, zoneKey: 'z', privateIp: '10.0.2.20' }] }], bootstrapScripts: [{ key: 'init', name: 'Init', type: 'shell', content: '[powershell]\nWrite-Output ok', targetHostKeys: ['h1','h2'] }],
      natGateways: [], eipDefinitions: [], securityGroupRules: [], aclDefinitions: [], snatEntries: [], dnatEntries: [], runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} }, hosts: { publicEntry: {}, officePrimary: {}, serverPrimary: {} } } as unknown as EnterpriseProvisionPlan;
    const input = { plan, rangeInstanceId: 'r', zoneId: 'zone', instanceType: 'ecs.fixture', hostInstanceTypes: {}, imageId: 'm-fixture', hostPasswords: {}, instancePassword: 'fixture', allowedIngressCidr: '0.0.0.0/0', tags: {} };
    expect(() => new AlibabaCloudOpenTofuRenderer().render(input)).toThrow('verified Windows');
    const result = new AlibabaCloudOpenTofuRenderer().render({ ...input, hostWindows: { h1: true } });
    expect(result.bootstrap_scripts[0]).toEqual({ key: 'init', name: 'Init', type: 'shell', content: '[powershell]\nWrite-Output ok', target_host_keys: ['h2'] });
    expect(result.bootstrap_scripts[1]).toMatchObject({ type: 'powershell', target_host_keys: ['h1'] });
  });
  it('renders the Tencent per-host PowerShell payload against explicitly selected Windows NICs', () => {
    const plan = { resourceNamePrefix: 'fixture', entryHostKey: 'member', network: { vpcCidr: '10.0.0.0/16', secondaryVpcCidrs: [] }, networkZones: [{ key: 'z', name: 'LAN', cidr: '10.0.2.0/24' }],
      hostDefinitions: [{ key: 'member', name: 'Member', hostName: 'member', zoneKey: 'z', privateIp: '10.0.2.20', dns: base.dns }],
      hostNetworkInterfaces: [{ hostKey: 'member', interfaces: [{ nicId: 'nic-secondary', deviceIndex: 0, zoneKey: 'z', privateIp: '10.0.2.20' }] }], bootstrapScripts: [], natGateways: [], eipDefinitions: [], securityGroupRules: [], aclDefinitions: [], snatEntries: [], dnatEntries: [] } as unknown as EnterpriseProvisionPlan;
    const input = { plan, rangeInstanceId: 'r', account: { provider: 'tencent_cloud' as const, accountUid: '100000000001', cloudAccountContextId: 'ctx', defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2', accessKeyId: 'fixture', accessKeySecret: 'fixture' }, hostInstanceTypes: { member: { instanceType: 'S5.MEDIUM4', cpu: 2 } }, hostImageIds: { member: 'img-fixture' }, hostPasswords: { member: 'FixturePassword123!' }, tags: { PlatformCreateJobId: 'job-fixture' }, expiresAt: '2100-01-01T00:00:00Z' };
    expect(() => renderTencentRangeVariables(input)).toThrow('verified Windows');
    const result = renderTencentRangeVariables({ ...input, hostWindows: { member: true } });
    expect(result.hosts[0].user_data).toMatch(/^<powershell>\n/);
    expect(result.hosts[0].user_data).toContain("nicId='nic-secondary';privateIp='10.0.2.20'");
  });
});
