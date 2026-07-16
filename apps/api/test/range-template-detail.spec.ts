import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('RangeTemplatesService getById', () => {
  it('returns the owner-visible draft topology instead of summary-only list fields', async () => {
    const repository = createMemoryAdminRepository();
    await repository.createPlatformUser({
      id: 'user-1',
      username: 'test',
      passwordHash: 'hash',
      role: 'user',
    });

    const service = new RangeTemplatesService(repository);
    const created = await service.create(
      {
        name: '企业攻防靶场',
        slug: 'enterprise-range',
        version: 'v1.0.0',
        modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
        topologySpec: {
          vpcCidr: '10.0.0.0/16',
          networkZones: [
            {
              key: 'core',
              name: 'Core',
              purpose: 'business-zone',
              cidr: '10.0.0.0/24',
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'ECS 1',
              zoneKey: 'core',
              role: 'host',
              privateIp: '10.0.0.10',
            },
          ],
          publicEntry: {
            hostKey: 'ecs-1',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
        topologyGraph: {
          schemaVersion: '2.0.0',
          nodes: [
            {
              id: 'ecs-1',
              kind: 'ecs',
              label: 'ECS 1',
              data: {},
            },
          ],
          edges: [],
        },
      },
      { id: 'user-1', role: 'user' },
    );

    const fetched = await service.getById(created.id, { id: 'user-1', role: 'user' });

    expect(fetched).toEqual(
      expect.objectContaining({
        id: created.id,
        createdBy: 'test',
        currentDraftVersion: expect.objectContaining({
          topologyGraph: expect.objectContaining({
            nodes: [expect.objectContaining({ id: 'ecs-1' })],
          }),
        }),
      }),
    );
  });
});
