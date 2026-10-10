export type HostDnsConfig = {
  servers: string[];
  nicIds: string[];
  domain?: string;
};

export function isHostDnsIpv4(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)
    && value.split('.').every((octet) => Number(octet) <= 255)
    && Number(value.split('.')[0]) > 0 && Number(value.split('.')[0]) < 224;
}

export function isHostDnsDomain(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && value.includes('.')
    && value.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
}

export function validateHostDnsConfig(value: unknown, nicIds: readonly string[], path = 'host.dns'): HostDnsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} 必须是 DNS 配置对象`);
  }
  const dns = value as Record<string, unknown>;
  if (Object.keys(dns).some((key) => !['servers', 'nicIds', 'domain'].includes(key))) {
    throw new Error(`${path} 包含未知字段`);
  }
  if (!Array.isArray(dns.servers) || dns.servers.length < 1 || dns.servers.length > 4
    || !dns.servers.every(isHostDnsIpv4) || new Set(dns.servers).size !== dns.servers.length) {
    throw new Error(`${path}.servers 必须包含 1–4 个不重复的 IPv4 DNS 地址`);
  }
  if (!Array.isArray(dns.nicIds) || dns.nicIds.length < 1
    || !dns.nicIds.every((id): id is string => typeof id === 'string' && id.trim() === id && id.length > 0 && nicIds.includes(id))
    || new Set(dns.nicIds).size !== dns.nicIds.length) {
    throw new Error(`${path}.nicIds 必须包含本主机不重复的真实 NIC ID`);
  }
  if (dns.domain !== undefined && !isHostDnsDomain(dns.domain)) {
    throw new Error(`${path}.domain 必须是合法的 ASCII AD DNS 域名`);
  }
  return { servers: [...dns.servers], nicIds: [...dns.nicIds], ...(dns.domain !== undefined ? { domain: dns.domain } : {}) };
}
