import { compileTemplateTopology } from '@aliyun-cyber-range/scenario-runtime/compiled';
import request from 'supertest';

import { collectRangeFixtureImage, createRangeApiFixture, rangeTemplatePayload } from './support/range-api-fixture';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('final authoring coverage: duplicate graph node IDs', () => {
  it('rejects duplicate node IDs during graph detection', async () => {
    const image = await collectRangeFixtureImage(createMemoryAdminRepository());
    const payload = rangeTemplatePayload(image, 'Duplicate detection', '10.0.0.0/16');
    payload.topologyGraph.nodes.push(structuredClone(payload.topologyGraph.nodes[1]!));
    expect(() => compileTemplateTopology(payload.topologyGraph, {
      name: 'Duplicate detection', slug: 'fixture', version: 'v1',
      cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    })).toThrow('节点 ID 无效或重复：switch-dmz');
  });

  it('rejects an injected duplicate node ID through HTTP save without changing the saved template', async () => {
    const fixture = await createRangeApiFixture();
    try {
      const image = await collectRangeFixtureImage(fixture.repository);
      const { name: _name, ...payload } = rangeTemplatePayload(image, 'Duplicate save', '10.0.0.0/16');
      const created = await request(fixture.app.getHttpServer()).post('/admin/scenarios')
        .set('authorization', `Bearer ${fixture.adminToken}`).send({ name: 'Duplicate save', ...payload }).expect(201);
      const savedBefore = await fixture.repository.getRangeTemplateById(created.body.id);
      const save = jest.spyOn(fixture.repository, 'saveRangeTemplateTopology');
      payload.topologyGraph.nodes.push(structuredClone(payload.topologyGraph.nodes[1]!));
      const response = await request(fixture.app.getHttpServer()).post(`/admin/scenarios/${created.body.id}/validate-and-save`)
        .set('authorization', `Bearer ${fixture.adminToken}`)
        .send({ ...payload, expectedRevision: created.body.revision }).expect(400);
      expect(response.body.message).toContain('节点 ID 无效或重复：switch-dmz');
      expect(save).not.toHaveBeenCalled();
      expect(await fixture.repository.getRangeTemplateById(created.body.id)).toEqual(savedBefore);
    } finally {
      await fixture.app.close();
    }
  });
});
