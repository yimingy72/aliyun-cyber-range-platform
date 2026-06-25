import type { RangeTemplateCompiledSpec, RangeTemplateTopologySpec } from './admin-types';
import type { TemplateNode } from '../components/admin/template-editor/template-property-panel';

type CompileTopologyGraphInput = {
  nodes: TemplateNode[];
  topologySpec?: RangeTemplateTopologySpec | null;
};

export function compileTopologyGraph(input: CompileTopologyGraphInput): RangeTemplateCompiledSpec {
  return {
    schemaVersion: '1.0.0',
    resources: input.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      provider: 'alibaba_cloud',
      config: node,
    })),
    topologySpec: input.topologySpec ?? null,
  };
}
