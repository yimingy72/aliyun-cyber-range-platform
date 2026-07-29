import {
  compileTemplateTopology,
  type TemplateAuthoringMetadata,
} from '@aliyun-cyber-range/scenario-runtime';

import { writeTopologyViewport } from '../components/admin/template-editor/topology-flow-adapter';
import type { TopologyViewport } from '../components/admin/template-editor/topology-flow-types';
import type { RangeTemplateCompiledSpec, RangeTemplateTopologySpec } from './admin-types';
import type { CompiledProvisionSpec } from './compiled-provision-spec';
import type { ScenarioGraphDraft } from './scenario-graph';
import type { ScenarioTemplateSpec } from './scenario-template-spec';

type BuildTopologyDraftPayloadInput = {
  graph: ScenarioGraphDraft;
  metadata: TemplateAuthoringMetadata;
  viewport: TopologyViewport | null;
};

export type TopologyDraftPayload = {
  topologyGraph: ScenarioGraphDraft & { viewport?: TopologyViewport };
  topologySpec: RangeTemplateTopologySpec;
  scenarioTemplateSpec: ScenarioTemplateSpec;
  compiledProvisionSpec: CompiledProvisionSpec;
  compiledSpec: RangeTemplateCompiledSpec;
};

export function buildTopologyDraftPayload({
  graph,
  metadata,
  viewport,
}: BuildTopologyDraftPayloadInput): TopologyDraftPayload {
  const graphWithViewport = writeTopologyViewport({
    ...graph,
    nodes: graph.nodes,
    edges: graph.edges,
  }, viewport);
  const compiled = compileTemplateTopology(graphWithViewport, metadata);

  return {
    topologyGraph: writeTopologyViewport({
      ...compiled.topologyGraph,
      nodes: compiled.topologyGraph.nodes,
      edges: compiled.topologyGraph.edges,
    }, viewport) as TopologyDraftPayload['topologyGraph'],
    topologySpec: compiled.topologySpec as RangeTemplateTopologySpec,
    scenarioTemplateSpec: compiled.scenarioTemplateSpec as ScenarioTemplateSpec,
    compiledProvisionSpec: compiled.compiledProvisionSpec as CompiledProvisionSpec,
    compiledSpec: compiled.compiledSpec as RangeTemplateCompiledSpec,
  };
}
