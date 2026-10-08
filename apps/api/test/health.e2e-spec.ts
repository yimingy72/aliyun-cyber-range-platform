import request from 'supertest';

import { createRangeApiFixture } from './support/range-api-fixture';

describe('Health endpoint', () => {
  let fixture: Awaited<ReturnType<typeof createRangeApiFixture>>;
  beforeAll(async () => { fixture = await createRangeApiFixture(); });
  afterAll(async () => { await fixture.app.close(); });

  it('returns service health metadata', async () => {
    await request(fixture.app.getHttpServer()).get('/health').expect(200)
      .expect({ status: 'ok', service: 'api' });
  });
});
