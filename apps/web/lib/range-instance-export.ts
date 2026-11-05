import type { RangeInstance, RangeInstanceDetail } from './admin-types';
import { formatAdminDateTime } from './admin-screen';

type Access = Pick<RangeInstance, 'id' | 'runtimeCredentials'>;
export type RangeExportItem = { detail: RangeInstanceDetail; access?: Access };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function rows(value: unknown) { return Array.isArray(value) ? value.map(record) : []; }
function text(value: unknown) { return typeof value === 'string' ? value : ''; }

function privateIps(node: Record<string, unknown>, host: Record<string, unknown>) {
  const nics = [...rows(node.nics), ...rows(node.networkInterfaces), ...rows(host.networkInterfaces)];
  return [...new Set([node.privateIp, host.primaryPrivateIp, ...nics.flatMap(nic => [nic.privateIp, ...(Array.isArray(nic.secondaryIps) ? nic.secondaryIps : [])])]
    .filter((ip): ip is string => typeof ip === 'string' && Boolean(ip.trim()) && !ip.includes('/')))].join(' / ');
}

function publicPorts(detail: RangeInstanceDetail, nodeId: string) {
  const compiled = detail.runtimeCompiledProvisionSpec;
  const mappings = Array.isArray(compiled?.dnatEntries) ? rows(compiled.dnatEntries).filter(entry => entry.hostKey === nodeId)
    : rows(detail.runtimeTopologyGraph?.nodes).filter(node => node.kind === 'switch')
      .flatMap(node => rows(record(node.nat).dnatMappings).filter(entry => entry.targetHostId === nodeId));
  const deployedIds = detail.resourceSummary?.dnatEntryIds;
  return mappings.filter(entry => (entry.protocol === 'tcp' || entry.protocol === 'udp')
    && Number.isInteger(entry.externalPort) && Number(entry.externalPort) > 0 && Number(entry.externalPort) <= 65535
    && Number.isInteger(entry.internalPort) && Number(entry.internalPort) > 0 && Number(entry.internalPort) <= 65535
    && (deployedIds == null || Boolean(deployedIds[`dnat-${nodeId}-${entry.protocol}-${entry.externalPort}`])))
    .map(entry => `${String(entry.protocol).toUpperCase()} ${entry.externalPort} → ${entry.internalPort}`).join(' / ');
}

function csvCell(value: string) {
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function rangeInstancesCsv(batchName: string, items: RangeExportItem[], includeCredentials = false) {
  const header = ['批次', '编排实例 ID', '编排实例名', '所属靶场', '平台状态', '公网 IP（DNAT IP）', '节点 ID', '节点名', '镜像',
    '节点私网 IP（平台配置）', '公网端口映射', '创建时间', '到期时间', ...(includeCredentials ? ['账号', '密码'] : [])];
  const lines: string[][] = [header];
  for (const { detail, access } of items) {
    const hosts = rows(detail.runtimeScenarioTemplateSpec?.hosts);
    const nodes = rows(detail.runtimeTopologyGraph?.nodes).filter(node => node.kind === 'ecs');
    for (const node of nodes.length ? nodes : [{} as Record<string, unknown>]) {
      const nodeId = text(node.id), host = hosts.find(candidate => candidate.key === nodeId) ?? {};
      const credential = access?.runtimeCredentials?.[nodeId];
      lines.push([batchName, detail.id, detail.name || detail.id, detail.templateNameSnapshot || '未知靶场', detail.status,
        detail.accessEntry?.publicIp || detail.dnatPublicIp || '', nodeId, text(node.label) || text(record(node.data).label) || nodeId,
        text(node.imageName) || text(node.imageId), privateIps(node, host), publicPorts(detail, nodeId),
        formatAdminDateTime(detail.createdAt), formatAdminDateTime(detail.expiresAt),
        ...(includeCredentials ? [credential?.username ?? '', credential?.password ?? ''] : [])]);
    }
  }
  return '\uFEFF' + lines.map(line => line.map(csvCell).join(',')).join('\r\n');
}

export function downloadRangeInstancesCsv(name: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = `${name.trim().replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_') || 'range-instances'}-ranges.csv`;
    document.body.appendChild(link); link.click();
  } finally { link.remove(); URL.revokeObjectURL(url); }
}
