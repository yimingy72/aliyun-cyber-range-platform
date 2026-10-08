import request from 'supertest';

import type { RangeProvisioner } from '../src/provisioning/provisioning.types';
import { collectRangeFixtureImage, createRangeApiFixture, futureExpiration, rangeTemplatePayload } from './support/range-api-fixture';

describe('Admin provisioning failures', () => {
  let fixture: Awaited<ReturnType<typeof createRangeApiFixture>>;
  let image: Awaited<ReturnType<typeof collectRangeFixtureImage>>;
  const failingProvisioner: RangeProvisioner = {
    async create(input) {
      await input.reportStep?.({ stepName: 'tofu_plan', status: 'running', message: 'Fake plan started.' });
      await input.reportStep?.({
        stepName: 'tofu_plan', status: 'failed', message: 'Fake plan failed.',
        stderrExcerpt: 'simulated stderr from fake plan',
      });
      throw new Error('OpenTofu plan failed in fake provisioner');
    },
    async destroy() {},
  };

  beforeAll(async () => {
    fixture = await createRangeApiFixture(failingProvisioner);
    image = await collectRangeFixtureImage(fixture.repository);
  });
  afterAll(async () => { await fixture.app.close(); });

  async function createInstance(name: string, vpcCidr: string) {
    const template = await request(fixture.app.getHttpServer()).post('/admin/scenarios')
      .set('authorization', `Bearer ${fixture.adminToken}`)
      .send(rangeTemplatePayload(image, name, vpcCidr)).expect(201);
    await request(fixture.app.getHttpServer()).post(`/admin/scenarios/${template.body.id}/share`)
      .set('authorization', `Bearer ${fixture.adminToken}`)
      .send({ expectedRevision: template.body.revision }).expect(200);
    const instance = await request(fixture.app.getHttpServer()).post('/admin/ranges')
      .set('authorization', `Bearer ${fixture.adminToken}`)
      .send({ name, templateId: template.body.id, expiresAt: futureExpiration() }).expect(201);
    return instance.body.id as string;
  }
  function rangeAction(id: string, action: string) {
    return request(fixture.app.getHttpServer()).post(`/admin/ranges/${id}/${action}`)
      .set('authorization', `Bearer ${fixture.adminToken}`).send({});
  }
  function get(url: string) {
    return request(fixture.app.getHttpServer()).get(url)
      .set('authorization', `Bearer ${fixture.adminToken}`);
  }

  it('copies failed job errors onto the range instance detail and keeps failed step logs', async () => {
    const id = await createInstance('Failure Template', '10.75.0.0/16');
    const createJob = await rangeAction(id, 'create').expect(201);
    await fixture.worker.process(createJob.body.id);
    const instanceDetail = await get(`/admin/ranges/${id}`).expect(200);
    expect(instanceDetail.body).toEqual(expect.objectContaining({
      id, status: 'create_failed', lastJobId: createJob.body.id,
      errorSummary: 'OpenTofu plan failed in fake provisioner',
    }));
    const jobDetail = await get(`/admin/provision-jobs/${createJob.body.id}`).expect(200);
    expect(jobDetail.body).toEqual(expect.objectContaining({
      id: createJob.body.id, status: 'failed', errorSummary: 'OpenTofu plan failed in fake provisioner',
    }));
    const jobSteps = await get(`/admin/provision-jobs/${createJob.body.id}/steps`).expect(200);
    expect(jobSteps.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepName: 'prepare', status: 'succeeded' }),
      expect.objectContaining({
        stepName: 'tofu_plan', status: 'failed', message: 'Fake plan failed.',
        stderrExcerpt: 'simulated stderr from fake plan',
      }),
    ]));
  });

  it('creates a retry job for a failed create instance and increments retryCount', async () => {
    const id = await createInstance('Retry Template', '10.76.0.0/16');
    const createJob = await rangeAction(id, 'create').expect(201);
    await fixture.worker.process(createJob.body.id);
    expect((await fixture.repository.getRangeInstanceById(id))!.status).toBe('create_failed');
    const retry = await rangeAction(id, 'retry').expect(201);
    expect(retry.body).toEqual(expect.objectContaining({
      rangeInstanceId: id, jobType: 'retry', status: 'pending', retryCount: 1,
    }));
    const latestDetail = await get(`/admin/ranges/${id}`).expect(200);
    expect(latestDetail.body).toEqual(expect.objectContaining({
      id, lastJobId: retry.body.id, status: 'pending_create',
    }));
  });
});
