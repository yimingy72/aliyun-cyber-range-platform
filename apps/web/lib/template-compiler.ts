import type { RangeTemplateCompiledSpec, RangeTemplateTopologySpec } from './admin-types';
import type { TemplateNode } from '../components/admin/template-editor/template-property-panel';

type CompileTopologyGraphInput = {
  topologySpec?: RangeTemplateTopologySpec | null;
  nodes: TemplateNode[];
};

function assertNever(value: never, message: string): never {
  throw new Error(message);
}

export function compileTopologyGraph(input: CompileTopologyGraphInput): RangeTemplateCompiledSpec {
  return {
    schemaVersion: '1.0.0',
    resources: input.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      provider: 'alibaba_cloud',
      config: compileNodeConfig(node),
    })),
    ...(input.topologySpec
      ? {
          topology: {
            vpcCidr: input.topologySpec.vpcCidr,
            publicEntryHostKey: input.topologySpec.publicEntry.hostKey,
            networkZoneKeys: input.topologySpec.networkZones.map((zone) => zone.key),
            hostKeys: input.topologySpec.hosts.map((host) => host.key),
          },
        }
      : {}),
  };
}

function compileNodeConfig(node: TemplateNode): Record<string, unknown> {
  switch (node.kind) {
    case 'host':
      return {
        label: node.label,
        zoneKey: node.zoneKey,
        role: node.role,
        privateIp: node.privateIp,
        exposePublic: node.exposePublic,
        image: node.image,
      };
    case 'switch':
      return {
        label: node.label,
        zoneKey: node.zoneKey,
        cidr: node.cidr,
        purpose: node.purpose,
        enableNat: node.enableNat,
      };
    case 'router':
      return {
        label: node.label,
        routeRole: node.routeRole,
        egressType: node.egressType,
        bindEip: node.bindEip,
      };
    case 'nat_gateway':
      return {
        label: node.label,
        zoneKey: node.zoneKey,
        snatEnabled: node.snatEnabled,
      };
    case 'eip':
      return {
        label: node.label,
        bindTargetType: node.bindTargetType,
        bindTargetKey: node.bindTargetKey,
        bandwidthMbps: node.bandwidthMbps,
      };
    case 'acl':
      return {
        label: node.label,
        zoneKey: node.zoneKey,
        direction: node.direction,
        policy: node.policy,
        protocol: node.protocol,
        portRange: node.portRange,
        sourceCidr: node.sourceCidr,
        priority: node.priority,
      };
    case 'security_group_rule':
      return {
        label: node.label,
        targetHostKey: node.targetHostKey,
        direction: node.direction,
        policy: node.policy,
        protocol: node.protocol,
        portRange: node.portRange,
        sourceCidr: node.sourceCidr,
        priority: node.priority,
      };
    default:
      return assertNever(node, `Unsupported template node kind: ${String((node as { kind?: unknown }).kind)}`);
  }
}
