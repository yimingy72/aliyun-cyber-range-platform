import request from 'supertest';

import type { RangeProvisioner } from '../src/provisioning/provisioning.types';
import { collectRangeFixtureImage, createRangeApiFixture, futureExpiration, rangeTemplatePayload } from './support/range-api-fixture';

describe('CIDR allocation', () => {
  let fixture: Awaited<ReturnType<typeof createRangeApiFixture>>;
  let templateId: string;
  let rangeInstanceId: string;
  const originalCidrPool = process.env.RANGE_CIDR_POOL;
  const provisionerSpy: RangeProvisioner & { create: jest.Mock; destroy: jest.Mock } = {
    mode: 'dry-run',
    create: jest.fn().mockResolvedValue({
      accessEntry: { url: 'https://range.local/fake', ssh: 'ssh root@range.local' },
      resourceSummary: { mode: 'dry-run' },
    }),
    destroy: jest.fn().mockResolvedValue(undefined),
  };

  async function createInstance(name: string) {
    const response = await request(fixture.app.getHttpServer()).post('/admin/ranges')
      .set('authorization', `Bearer ${fixture.adminToken}`)
      .send({ name, templateId, expiresAt: futureExpiration() }).expect(201);
    return response.body.id as string;
  }
  async function processCreate(id: string) {
    const job = await request(fixture.app.getHttpServer()).post(`/admin/ranges/${id}/create`)
      .set('authorization', `Bearer ${fixture.adminToken}`).send({}).expect(201);
    expect(job.body.jobType).toBe('create');
    await fixture.worker.process(job.body.id);
    expect((await fixture.repository.getRangeInstanceById(id))!.status).toBe('running');
  }

  beforeAll(async () => {
    fixture = await createRangeApiFixture(provisionerSpy);
    const image = await collectRangeFixtureImage(fixture.repository);
    const template = await request(fixture.app.getHttpServer()).post('/admin/scenarios')
      .set('authorization', `Bearer ${fixture.adminToken}`)
      .send({
        ...rangeTemplatePayload(image, 'Enterprise Practice Range'),
        variableSchema: { vpc_cidr: 'string' }, outputSchema: { public_entry: 'object' },
      }).expect(201);
    templateId = template.body.id;
    await request(fixture.app.getHttpServer()).post(`/admin/scenarios/${templateId}/share`)
      .set('authorization', `Bearer ${fixture.adminToken}`)
      .send({ expectedRevision: template.body.revision }).expect(200);
    rangeInstanceId = await createInstance('CIDR 分配实例 A');
  });
  afterAll(async () => {
    if (originalCidrPool === undefined) delete process.env.RANGE_CIDR_POOL;
    else process.env.RANGE_CIDR_POOL = originalCidrPool;
    await fixture.app.close();
  });

  it('prefers the template vpc cidr over the optional cidr pool when creation starts', async () => {
    process.env.RANGE_CIDR_POOL = '10.80.0.0/16,10.81.0.0/16';
    await processCreate(rangeInstanceId);
    expect(provisionerSpy.create).toHaveBeenCalledWith(expect.objectContaining({ allocatedCidr: '10.70.0.0/16' }));
    const instances = await request(fixture.app.getHttpServer()).get('/admin/ranges')
      .set('authorization', `Bearer ${fixture.adminToken}`).expect(200);
    expect(instances.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: rangeInstanceId, status: 'running' }),
    ]));
    const detail = await request(fixture.app.getHttpServer()).get(`/admin/ranges/${rangeInstanceId}`)
      .set('authorization', `Bearer ${fixture.adminToken}`).expect(200);
    expect(detail.body).toEqual(expect.objectContaining({ allocatedCidr: '10.70.0.0/16' }));
  });

  it('does not require a cidr pool when the template already defines a fixed vpc cidr', async () => {
    process.env.RANGE_CIDR_POOL = '';
    const id = await createInstance('CIDR 分配实例 B');
    await processCreate(id);
    expect(provisionerSpy.create).toHaveBeenCalledWith(expect.objectContaining({
      rangeInstanceId: id, allocatedCidr: '10.70.0.0/16',
    }));
    const detail = await request(fixture.app.getHttpServer()).get(`/admin/ranges/${id}`)
      .set('authorization', `Bearer ${fixture.adminToken}`).expect(200);
    expect(detail.body).toEqual(expect.objectContaining({ id, allocatedCidr: '10.70.0.0/16' }));
  });
});
