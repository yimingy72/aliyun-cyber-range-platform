import type { RangeTemplateTopologySpec } from './admin-types';
import type { TemplateNode } from './scenario-graph';

type SyncTopologySpecInput = {
  nodes: TemplateNode[];
};

function formatZoneName(zoneKey: string) {
  if (zoneKey === 'dmz') {
    return 'DMZ';
  }

  return zoneKey.charAt(0).toUpperCase() + zoneKey.slice(1);
}

function buildExecutionPolicies(nodes: TemplateNode[]) {
  const publicHost = nodes.find((node) => node.kind === 'ecs' && node.exposePublic);

  return {
    allowSshIngress: Boolean(publicHost),
    allowHttpIngress: Boolean(publicHost),
    enableSnatOnDemand: nodes.some(
      (node) => node.kind === 'switch' && (node.nat?.snatEnabled || node.snatEnabled || node.enableNat),
    ),
  };
}

export function syncTopologySpecFromNodes(input: SyncTopologySpecInput): RangeTemplateTopologySpec {
  const switchNodes = input.nodes.filter((node): node is Extract<TemplateNode, { kind: 'switch' }> => node.kind === 'switch');
  const hostNodes = input.nodes.filter((node): node is Extract<TemplateNode, { kind: 'ecs' }> => node.kind === 'ecs');
  const switchById = new Map(switchNodes.map((node) => [node.id, node]));
  const entryHost = hostNodes.find((node) => node.exposePublic || node.role === 'entry');

  return {
    vpcCidr: '10.0.0.0/16',
    networkZones: switchNodes.map((node) => ({
      key: node.zoneKey,
      name: formatZoneName(node.zoneKey),
      purpose: node.purpose,
      cidr: node.cidr,
      ...(node.zoneKey === 'dmz' ? { isPublicEntry: true } : {}),
    })),
    hosts: hostNodes.map((node) => {
      const primaryNic = node.nics?.[0];
      const resolvedSwitch =
        primaryNic && typeof primaryNic.switchId === 'string' ? switchById.get(primaryNic.switchId) : null;

      return {
        key: node.id,
        name: node.label,
        zoneKey: resolvedSwitch?.zoneKey ?? primaryNic?.zoneKey ?? node.zoneKey,
        role: node.role,
        privateIp: primaryNic?.privateIp ?? node.privateIp,
        exposePublic: node.exposePublic,
      };
    }),
    publicEntry: {
      hostKey: entryHost?.id ?? '',
      protocols: entryHost
        ? [
            { protocol: 'ssh', port: 22 },
            { protocol: 'http', port: 80 },
          ]
        : [],
    },
    executionPolicies: buildExecutionPolicies(input.nodes),
  };
}
