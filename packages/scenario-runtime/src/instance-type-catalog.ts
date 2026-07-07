export type InstanceTypeCandidateCatalogEntry = {
  cpu: number;
  memory: number;
  preferredInstanceTypes: string[];
};

export const INSTANCE_TYPE_CANDIDATE_CATALOG: InstanceTypeCandidateCatalogEntry[] = [
  {
    cpu: 2,
    memory: 2,
    preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m1.large'],
  },
  {
    cpu: 4,
    memory: 8,
    preferredInstanceTypes: ['ecs.e-c1m2.xlarge'],
  },
  {
    cpu: 8,
    memory: 16,
    preferredInstanceTypes: ['ecs.e-c1m2.2xlarge'],
  },
];

export function resolveFixedInstanceType(cpu?: number, memory?: number) {
  return resolvePreferredInstanceTypes(cpu, memory)[0] ?? null;
}

export function resolvePreferredInstanceTypes(cpu?: number, memory?: number) {
  if (!Number.isFinite(cpu) || !Number.isFinite(memory)) {
    return [];
  }

  const preferredInstanceTypes = INSTANCE_TYPE_CANDIDATE_CATALOG.find(
    (entry) => entry.cpu === cpu && entry.memory === memory,
  )?.preferredInstanceTypes;

  return preferredInstanceTypes ? [...preferredInstanceTypes] : [];
}
