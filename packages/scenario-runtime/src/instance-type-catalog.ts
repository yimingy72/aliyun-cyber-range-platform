export type InstanceTypeCandidateCatalogEntry = {
  readonly cpu: number;
  readonly memory: number;
  readonly preferredInstanceTypes: readonly string[];
};

const EMPTY_PREFERRED_INSTANCE_TYPES: readonly string[] = Object.freeze([]);

function freezeCatalogEntry(entry: InstanceTypeCandidateCatalogEntry): InstanceTypeCandidateCatalogEntry {
  return Object.freeze({
    ...entry,
    preferredInstanceTypes: Object.freeze([...entry.preferredInstanceTypes]),
  });
}

export const INSTANCE_TYPE_CANDIDATE_CATALOG: readonly InstanceTypeCandidateCatalogEntry[] = Object.freeze([
  freezeCatalogEntry({
    cpu: 2,
    memory: 2,
    preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m1.large'],
  }),
  freezeCatalogEntry({
    cpu: 2,
    memory: 4,
    preferredInstanceTypes: ['ecs.e-c1m2.large', 'ecs.u1-c1m2.large'],
  }),
  freezeCatalogEntry({
    cpu: 4,
    memory: 8,
    preferredInstanceTypes: ['ecs.e-c1m2.xlarge', 'ecs.u1-c1m2.xlarge'],
  }),
  freezeCatalogEntry({
    cpu: 8,
    memory: 16,
    preferredInstanceTypes: ['ecs.e-c1m2.2xlarge', 'ecs.u1-c1m2.2xlarge'],
  }),
]);

export function resolveFixedInstanceType(cpu?: number, memory?: number) {
  return resolvePreferredInstanceTypes(cpu, memory)[0] ?? null;
}

export function resolvePreferredInstanceTypes(cpu?: number, memory?: number): readonly string[] {
  if (!Number.isFinite(cpu) || !Number.isFinite(memory)) {
    return EMPTY_PREFERRED_INSTANCE_TYPES;
  }

  const preferredInstanceTypes = INSTANCE_TYPE_CANDIDATE_CATALOG.find(
    (entry) => entry.cpu === cpu && entry.memory === memory,
  )?.preferredInstanceTypes;

  return preferredInstanceTypes ? Object.freeze([...preferredInstanceTypes]) : EMPTY_PREFERRED_INSTANCE_TYPES;
}
