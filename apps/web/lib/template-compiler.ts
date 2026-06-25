import type { RangeTemplateCompiledSpec } from './admin-types';
import type { TemplateNode } from '../components/admin/template-editor/template-property-panel';

type CompileTopologyGraphInput = {
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
    default:
      return assertNever(node, `Unsupported template node kind: ${String((node as { kind?: unknown }).kind)}`);
  }
}
