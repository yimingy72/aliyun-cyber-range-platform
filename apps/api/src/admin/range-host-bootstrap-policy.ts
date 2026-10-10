import { ConflictException } from '@nestjs/common';
import type { RangeInstanceRecord } from './admin.repository';

// user_data may be ForceNew and cannot safely reconfigure a running Windows guest.
export function assertExistingHostBootstrapUnchanged(instance: RangeInstanceRecord, draft: Record<string, unknown>) {
  const nodes = (graph: Record<string, unknown> | null | undefined) => (Array.isArray(graph?.nodes) ? graph.nodes : []).filter((node): node is Record<string, any> => Boolean(node && typeof node === 'object' && (node as any).kind === 'ecs'));
  const deployed = new Map(nodes(instance.runtimeTopologyGraph).map(node => [node.id, node]));
  for (const node of nodes(draft)) {
    const original = deployed.get(node.id);
    if (!original || !instance.resourceSummary?.hostIds?.[node.id]) continue;
    const config = (host: Record<string, any>) => JSON.stringify({ dns: host.dns ?? null,
      dnsNics: host.dns ? (host.nics ?? []).filter((nic: any) => host.dns.nicIds?.includes(nic.id)).map((nic: any) => ({ id: nic.id, privateIp: nic.privateIp, switchId: nic.switchId })) : [], initScript: host.initScript ?? '' });
    if (config(original) !== config(node)) throw new ConflictException('运行中主机的 DNS、作用网卡和启动脚本不能通过拓扑应用修改，请在模板中配置后创建新实例；核验 DNS 不会重建主机。');
  }
}
