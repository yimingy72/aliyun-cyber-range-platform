export type FixedInstanceTypeCatalogEntry = {
  cpu: number;
  memory: number;
  instanceType: string;
};

export const FIXED_INSTANCE_TYPE_CATALOG: FixedInstanceTypeCatalogEntry[] = [
  {
    cpu: 1,
    memory: 2,
    instanceType: 'ecs.u1-c1m2.large',
  },
  {
    cpu: 2,
    memory: 4,
    instanceType: 'ecs.c7.large',
  },
  {
    cpu: 4,
    memory: 8,
    instanceType: 'ecs.c7.xlarge',
  },
];

export function resolveFixedInstanceType(cpu?: number, memory?: number) {
  if (!Number.isFinite(cpu) || !Number.isFinite(memory)) {
    return null;
  }

  return (
    FIXED_INSTANCE_TYPE_CATALOG.find((entry) => entry.cpu === cpu && entry.memory === memory)?.instanceType ?? null
  );
}
