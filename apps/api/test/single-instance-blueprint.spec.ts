import { buildSingleInstanceBlueprint } from '../src/admin/single-instance-blueprint';

describe('buildSingleInstanceBlueprint', () => {
  it('keeps the generated instance type candidates strict for a single instance', () => {
    const blueprint = buildSingleInstanceBlueprint({
      name: 'training-host',
      hostKey: 'single-ecs-1',
      hostName: 'training-host',
      privateIp: '10.0.0.10',
      password: 'ChangeMe123!',
      cpu: 2,
      memory: 4,
      image: { imageId: 'm-training', displayName: 'Training image' } as never,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      vpcCidr: '10.0.0.0/16',
      zoneKey: 'single-zone',
      zoneCidr: '10.0.0.0/24',
    });

    expect(blueprint.runtimeScenarioTemplateSpec.runtimePreferences.instanceTypePolicies).toEqual([
      expect.objectContaining({
        mode: 'fixed',
        preferredInstanceTypes: ['ecs.e-c1m2.large', 'ecs.u1-c1m2.large'],
      }),
    ]);
  });
});
