import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/bootstrap/configure-app';

@Controller('parser-probe')
class ParserProbeController {
  calls = 0;

  @Post()
  accept(@Body() body: { topologyGraph: { nodes: Array<{ initScript: string }> } }) {
    this.calls++;
    return { nodes: body.topologyGraph.nodes.length };
  }
}

describe('bounded topology JSON request parsing', () => {
  let app: INestApplication;
  let controller: ParserProbeController;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ParserProbeController] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    controller = app.get(ParserProbeController);
  });
  afterAll(async () => { await app.close(); });

  it('accepts compiled topology payloads above the old 100 KiB limit', async () => {
    const body = { topologyGraph: { nodes: Array.from({ length: 3 }, () => ({ initScript: 'x'.repeat(60 * 1024) })) } };
    await request(app.getHttpServer()).post('/parser-probe').send(body).expect(201, { nodes: 3 });
  });

  it('rejects over 8 MiB before reaching a controller', async () => {
    const prior = controller.calls;
    await request(app.getHttpServer()).post('/parser-probe')
      .send({ topologyGraph: { nodes: [{ initScript: 'x'.repeat(8 * 1024 * 1024) }] } }).expect(413);
    expect(controller.calls).toBe(prior);
  });

  it('still rejects malformed JSON', async () => {
    const prior = controller.calls;
    await request(app.getHttpServer()).post('/parser-probe').set('Content-Type', 'application/json')
      .send('{"topologyGraph":').expect(400);
    expect(controller.calls).toBe(prior);
  });
});
