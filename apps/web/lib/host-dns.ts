import type { EcsTemplateNode } from './scenario-graph';
import { isHostDnsDomain, isHostDnsIpv4 } from '@aliyun-cyber-range/scenario-runtime';

export function readHostDns(value: unknown): EcsTemplateNode['dns'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const dns = value as Record<string, unknown>;
  return {
    servers: Array.isArray(dns.servers) ? dns.servers.filter((item): item is string => typeof item === 'string') : [],
    nicIds: Array.isArray(dns.nicIds) ? dns.nicIds.filter((item): item is string => typeof item === 'string') : [],
    ...(typeof dns.domain === 'string' ? { domain: dns.domain } : {}),
  };
}

export function hostDnsErrors(node: EcsTemplateNode): string[] {
  if (!node.dns) return [];
  const { servers, nicIds, domain } = node.dns;
  const errors: string[] = [];
  if (servers.length < 1 || servers.length > 4) errors.push('请填写 1–4 个 DNS 服务器 IPv4 地址');
  if (servers.some((server) => !isHostDnsIpv4(server))) {
    errors.push('DNS 服务器必须是有效的 IPv4 地址');
  }
  if (new Set(servers).size !== servers.length) errors.push('DNS 服务器地址不能重复');
  if (nicIds.length === 0) errors.push('请选择 DNS 作用网卡');
  if (new Set(nicIds).size !== nicIds.length) errors.push('DNS 作用网卡不能重复');
  if (nicIds.some((id) => !node.nics?.some((nic) => nic.id === id))) errors.push('DNS 作用网卡已不存在，请重新选择');
  if (nicIds.some((id) => node.nics?.some((nic) => nic.id === id && !nic.privateIp.trim()))) {
    errors.push('DNS 作用网卡需要填写私网 IP');
  }
  if (domain !== undefined && !isHostDnsDomain(domain)) {
    errors.push('验证域名格式不正确，例如 lab.example');
  }
  return errors;
}
