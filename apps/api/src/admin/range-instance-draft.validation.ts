import { isDeepStrictEqual } from 'node:util';

import { BadRequestException } from '@nestjs/common';
import { preserveOmittedHostPasswords } from './topology-secret-preservation';
import {
  compileTemplateTopology,
  type CompiledTemplatePayload,
  type ScenarioGraphDraft,
  type TemplateAuthoringMetadata,
  type TemplateImageOsHints,
} from '@aliyun-cyber-range/scenario-runtime/compiled';

export function validateRangeInstanceDraftPayload(input: {
  draftTopologyGraph: Record<string, unknown>;
  draftTopologySpec: Record<string, unknown>;
  draftScenarioTemplateSpec: Record<string, unknown>;
  draftCompiledProvisionSpec: Record<string, unknown>;
}, metadata: TemplateAuthoringMetadata, sourceGraph?: Record<string, unknown> | null, imageOsHints: TemplateImageOsHints = {}): CompiledTemplatePayload {
  if (!isPlainObject(input.draftTopologyGraph)) {
    throw new BadRequestException('draftTopologyGraph must be a plain object');
  }

  if (!isPlainObject(input.draftTopologySpec)) {
    throw new BadRequestException('draftTopologySpec must be a plain object');
  }

  if (!isPlainObject(input.draftScenarioTemplateSpec)) {
    throw new BadRequestException('draftScenarioTemplateSpec must be a plain object');
  }

  if (!isPlainObject(input.draftCompiledProvisionSpec)) {
    throw new BadRequestException('draftCompiledProvisionSpec must be a plain object');
  }

  const nodes = input.draftTopologyGraph.nodes;

  if (!Array.isArray(nodes)) {
    throw new BadRequestException('draftTopologyGraph.nodes must be an array');
  }

  let compiled: CompiledTemplatePayload;

  try {
    compiled = compileTemplateTopology(input.draftTopologyGraph as ScenarioGraphDraft, metadata, imageOsHints);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid range instance topology draft';
    throw new BadRequestException(message);
  }

  const canonicalCompiled: CompiledTemplatePayload = {
    ...compiled,
    topologyGraph: toJsonRecord(compiled.topologyGraph) as ScenarioGraphDraft,
    topologySpec: toJsonRecord(compiled.topologySpec),
    scenarioTemplateSpec: toJsonRecord(compiled.scenarioTemplateSpec),
    compiledProvisionSpec: toJsonRecord(compiled.compiledProvisionSpec),
    compiledSpec: toJsonRecord(compiled.compiledSpec),
  };

  if (!isDeepStrictEqual(input.draftTopologySpec, canonicalCompiled.topologySpec)) {
    throw new BadRequestException('draftTopologySpec does not match draftTopologyGraph');
  }

  if (!isDeepStrictEqual(input.draftScenarioTemplateSpec, canonicalCompiled.scenarioTemplateSpec)) {
    throw new BadRequestException('draftScenarioTemplateSpec does not match draftTopologyGraph');
  }

  if (!isDeepStrictEqual(input.draftCompiledProvisionSpec, canonicalCompiled.compiledProvisionSpec)) {
    throw new BadRequestException('draftCompiledProvisionSpec does not match draftTopologyGraph');
  }

  const preserved = preserveOmittedHostPasswords(sourceGraph, input.draftTopologyGraph);
  if (preserved !== input.draftTopologyGraph) {
    // Validate caller snapshots before restoring server-owned opaque secrets and recompiling.
    return JSON.parse(JSON.stringify(compileTemplateTopology(preserved as ScenarioGraphDraft, metadata, imageOsHints))) as CompiledTemplatePayload;
  }
  return canonicalCompiled;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
