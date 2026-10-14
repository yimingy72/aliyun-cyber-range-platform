import request from 'supertest';

import { collectRangeFixtureImage, createRangeApiFixture, futureExpiration, rangeTemplatePayload } from './support/range-api-fixture';

describe('Admin resource validation', () => {
  let fixture: Awaited<ReturnType<typeof createRangeApiFixture>>;
  let image: Awaited<ReturnType<typeof collectRangeFixtureImage>>;

  beforeAll(async () => {
    fixture = await createRangeApiFixture();
    image = await collectRangeFixtureImage(fixture.repository);
  });
  afterAll(async () => { await fixture.app.close(); });

  function createTemplate(payload: object) {
    return request(fixture.app.getHttpServer()).post('/admin/scenarios')
      .set('authorization', `Bearer ${fixture.adminToken}`).send(payload);
  }
  function rangeAction(id: string, action: string) {
    return request(fixture.app.getHttpServer()).post(`/admin/ranges/${id}/${action}`)
      .set('x-idempotency-key', `${id}-${action}`)
      .set('authorization', `Bearer ${fixture.adminToken}`).send({});
  }
  async function createProvisioningFixture() {
    const template = await createTemplate(rangeTemplatePayload(image, 'Fixture Template')).expect(201);
    await request(fixture.app.getHttpServer()).post(`/admin/scenarios/${template.body.id}/share`)
      .set('authorization', `Bearer ${fixture.adminToken}`)
      .send({ expectedRevision: template.body.revision }).expect(200);
    const instance = await request(fixture.app.getHttpServer()).post('/admin/ranges')
      .set('authorization', `Bearer ${fixture.adminToken}`)
      .send({ name: 'Fixture Range', templateId: template.body.id, expiresAt: futureExpiration() }).expect(201);
    return instance.body.id as string;
  }

  it.each(['slug', 'version', 'cloudProvider', 'iacType', 'modulePathOrRef'])('rejects client-controlled %s on templates', async (field) => {
    const response = await createTemplate({ ...rangeTemplatePayload(image, 'Managed Template'), [field]: 'client-value' }).expect(400);
    expect(response.body.message).toEqual(expect.arrayContaining([`property ${field} should not exist`]));
  });

  it('rejects templates without a topology spec', async () => {
    const { topologySpec: _missing, ...payload } = rangeTemplatePayload(image, 'Missing topology');
    const response = await createTemplate(payload).expect(400);
    expect(response.body.message).toEqual(expect.arrayContaining(['topologySpec should not be null or undefined']));
  });

  it('rejects templates when topology spec is missing vpc cidr', async () => {
    const payload = rangeTemplatePayload(image, 'Missing CIDR');
    delete payload.topologySpec.vpcCidr;
    const response = await createTemplate(payload).expect(400);
    expect(String(response.body.message)).toContain('vpcCidr');
  });

  it('rejects templates when a host references an unknown network zone', async () => {
    const payload = rangeTemplatePayload(image, 'Unknown zone');
    (payload.topologySpec.hosts as Array<{ zoneKey: string }>)[0]!.zoneKey = 'missing-zone';
    const response = await createTemplate(payload).expect(400);
    expect(response.body.message).toContain('unknown network zone');
  });

  it('rejects creating a template when compiled topology summary mismatches topology spec', async () => {
    const payload = rangeTemplatePayload(image, 'Mismatched compilation');
    (payload.compiledSpec.topology as { publicEntryHostKey: string }).publicEntryHostKey = 'wrong-host';
    const response = await createTemplate(payload).expect(400);
    expect(response.body.message).toContain('compiledSpec does not match topologyGraph');
  });

  it('rejects templates when public entry host is missing from hosts', async () => {
    const payload = rangeTemplatePayload(image, 'Missing entry');
    (payload.topologySpec.publicEntry as { hostKey: string }).hostKey = 'missing-host';
    const response = await createTemplate(payload).expect(400);
    expect(response.body.message).toContain('Public entry host');
  });

  it('rejects destroying a draft range instance', async () => {
    const id = await createProvisioningFixture();
    await rangeAction(id, 'destroy').expect(409);
  });

  it('rejects starting a second create job for a running range instance', async () => {
    const id = await createProvisioningFixture();
    const job = await rangeAction(id, 'create').expect(201);
    await fixture.worker.process(job.body.id);
    expect((await fixture.repository.getRangeInstanceById(id))!.status).toBe('running');
    await rangeAction(id, 'create').expect(409);
  });

  it('rejects retrying a running range instance', async () => {
    const id = await createProvisioningFixture();
    const job = await rangeAction(id, 'create').expect(201);
    await fixture.worker.process(job.body.id);
    expect((await fixture.repository.getRangeInstanceById(id))!.status).toBe('running');
    await rangeAction(id, 'retry').expect(409);
  });
});
