import { describe, expect, it } from 'vitest';
import { rangeInstancesCsv } from './range-instance-export';
import type { RangeInstanceDetail } from './admin-types';

const detail: RangeInstanceDetail = { id: 'range-1', name: '测试靶场', status: 'running', templateId: 'template-1', templateNameSnapshot: '模板',
  createdAt: '2026-10-20T00:00:00Z', expiresAt: '2026-10-20T12:00:00Z', accessEntry: { publicIp: '198.51.100.1', ssh: 'sensitive-ssh-not-exported' },
  runtimeCredentials: { host: { username: 'detail-user', password: 'detail-password-not-exported' } },
  runtimeTopologyGraph: { nodes: [{ id: 'host', kind: 'ecs', label: '多网卡主机', imageName: '测试镜像', nics: [
    { privateIp: '172.16.10.10', secondaryIps: ['172.16.10.11'] }, { privateIp: '172.16.20.10' }] }] },
  runtimeCompiledProvisionSpec: { dnatEntries: [{ hostKey: 'host', protocol: 'tcp', externalPort: 2222, internalPort: 22 },
    { hostKey: 'host', protocol: 'tcp', externalPort: 3333, internalPort: 33 }] },
  resourceSummary: { dnatEntryIds: { 'dnat-host-tcp-2222': 'entry-1' } },
  draftTopologyGraph: { nodes: [{ id: 'draft', kind: 'ecs', label: '未下发草稿', privateIp: '10.9.9.9' }] },
};

describe('range information CSV', () => {
  it('uses deployed nodes, every NIC and proven DNAT ports without credential fields by default', () => {
    const csv = rangeInstancesCsv('批次', [{ detail }]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    for (const value of ['多网卡主机', '172.16.10.10', '172.16.10.11', '172.16.20.10', 'TCP 2222 → 22']) expect(csv).toContain(value);
    for (const value of ['密码', 'detail-user', 'detail-password-not-exported', 'sensitive-ssh-not-exported', '未下发草稿', '3333']) expect(csv).not.toContain(value);
  });
  it('includes credentials only from the explicitly requested access response, without guessing accounts', () => {
    const access = { id: detail.id, runtimeCredentials: { host: { username: 'Administrator', password: '  =fixture-formula' } } };
    const csv = rangeInstancesCsv('批次', [{ detail, access }], true);
    expect(csv).toContain('账号,密码');
    expect(csv).toContain("Administrator,'  =fixture-formula");
    expect(csv).not.toContain('detail-password-not-exported');
    expect(rangeInstancesCsv('批次', [{ detail }], true)).not.toContain('root');
  });
  it('quotes commas, line breaks and quotes, and neutralizes spreadsheet formulas', () => {
    const csv = rangeInstancesCsv('@batch', [{ detail: { ...detail, name: '=formula', templateNameSnapshot: '有,"引号"\n名称' } }]);
    expect(csv).toContain("'@batch"); expect(csv).toContain("'=formula");
    expect(csv).toContain('"有,""引号""\n名称"');
  });
  it('retains a row for a historical instance without any node definition', () => {
    const csv = rangeInstancesCsv('', [{ detail: { ...detail, status: 'destroyed', runtimeTopologyGraph: null } }]);
    expect(csv.split('\r\n')).toHaveLength(2); expect(csv).toContain('range-1');
  });
});
