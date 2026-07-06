import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('Range instance runtime snapshot persistence', () => {
  it('persists runtime and draft snapshots on a created range instance', async () => {
    const repository = createMemoryAdminRepository();

    const template = await repository.createRangeTemplate({
      name: 'Runtime Snapshot Template',
      slug: 'runtime-snapshot-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: {
        vpcCidr: '10.99.0.0/16',
        networkZones: [
          { key: 'dmz', name: 'DMZ', purpose: 'public-entry', cidr: '10.99.10.0/24', isPublicEntry: true },
        ],
        hosts: [
          { key: 'checker', name: 'checker', zoneKey: 'dmz', role: 'entry', privateIp: '10.99.10.10', exposePublic: true },
        ],
        publicEntry: {
          hostKey: 'checker',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const created = await repository.createRangeInstance({
      name: '靶场实例 A',
      createdBy: 'admin',
      templateId: template.id,
      expiresAt: '2026-07-08T18:00:00.000Z',
      runtimeTopologyGraph: { schemaVersion: '1', nodes: [], edges: [] },
      runtimeScenarioTemplateSpec: { metadata: { name: '靶场实例 A' } },
      runtimeCompiledProvisionSpec: { topology: { vpcCidr: '10.0.0.0/16' } },
    });

    expect(created.createdBy).toBe('admin');
    expect(created.runtimeTopologyGraph).toEqual(
      expect.objectContaining({ schemaVersion: '1' }),
    );
    expect(created.runtimeScenarioTemplateSpec).toEqual(
      expect.objectContaining({ metadata: expect.objectContaining({ name: '靶场实例 A' }) }),
    );
    expect(created.runtimeCompiledProvisionSpec).toEqual(
      expect.objectContaining({ topology: expect.objectContaining({ vpcCidr: '10.0.0.0/16' }) }),
    );
    expect(created.draftTopologyGraph).toBeNull();
    expect(created.draftScenarioTemplateSpec).toBeNull();
    expect(created.draftCompiledProvisionSpec).toBeNull();
    expect(created.draftUpdatedBy).toBeNull();
    expect(created.draftUpdatedAt).toBeNull();
  });
});
