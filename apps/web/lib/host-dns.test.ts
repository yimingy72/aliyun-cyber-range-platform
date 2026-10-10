import { describe, expect, it } from 'vitest';
import { hostDnsErrors, readHostDns } from './host-dns';
import type { EcsTemplateNode } from './scenario-graph';

const host = { nics: [{ id: 'primary', privateIp: '10.0.50.20' }, { id: 'secondary', privateIp: '172.16.50.20' }] } as EcsTemplateNode;

describe('host DNS authoring', () => {
  it('leaves automatic DNS absent and retains explicit NIC IDs when reading a draft', () => {
    expect(readHostDns(undefined)).toBeUndefined();
    expect(readHostDns({ servers: ['10.0.50.10'], nicIds: ['missing'], domain: 'lab.example' })).toEqual({ servers: ['10.0.50.10'], nicIds: ['missing'], domain: 'lab.example' });
    expect(hostDnsErrors(host)).toEqual([]);
  });
  it('accepts an ordered server list on named NICs with an AD domain', () => {
    expect(hostDnsErrors({ ...host, dns: { servers: ['10.0.50.10', '10.0.50.11'], nicIds: ['secondary'], domain: 'ad.lab.example' } })).toEqual([]);
  });
  it.each([
    [{ servers: [], nicIds: ['primary'] }, '请填写 1–4 个 DNS 服务器 IPv4 地址'],
    [{ servers: ['256.0.0.1'], nicIds: ['primary'] }, 'DNS 服务器必须是有效的 IPv4 地址'],
    [{ servers: ['10.0.50.10', '10.0.50.10'], nicIds: ['primary'] }, 'DNS 服务器地址不能重复'],
    [{ servers: ['10.0.50.10'], nicIds: [] }, '请选择 DNS 作用网卡'],
    [{ servers: ['10.0.50.10'], nicIds: ['missing'] }, 'DNS 作用网卡已不存在，请重新选择'],
    [{ servers: ['10.0.50.10'], nicIds: ['primary'], domain: '-bad.example' }, '验证域名格式不正确，例如 lab.example'],
  ])('reports invalid configuration without selecting a replacement NIC', (dns, message) => {
    expect(hostDnsErrors({ ...host, dns })).toContain(message);
  });
});
