import { BadRequestException } from '@nestjs/common';

export function validateRangeInstanceDraftPayload(input: {
  draftTopologyGraph: Record<string, unknown>;
  draftScenarioTemplateSpec: Record<string, unknown>;
  draftCompiledProvisionSpec: Record<string, unknown>;
}) {
  if (!isPlainObject(input.draftTopologyGraph)) {
    throw new BadRequestException('draftTopologyGraph must be a plain object');
  }

  if (!isPlainObject(input.draftScenarioTemplateSpec)) {
    throw new BadRequestException('draftScenarioTemplateSpec must be a plain object');
  }

  if (!isPlainObject(input.draftCompiledProvisionSpec)) {
    throw new BadRequestException('draftCompiledProvisionSpec must be a plain object');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
