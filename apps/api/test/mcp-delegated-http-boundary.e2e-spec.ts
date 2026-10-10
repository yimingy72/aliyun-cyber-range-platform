import { Controller, Get, INestApplication, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { OidcJwtVerifier } from '../src/admin/oidc-jwt-verifier';
import { OidcPrincipalResolver } from '../src/admin/oidc-principal-resolver';
import { McpResponseInterceptor } from '../src/auth/mcp-response.interceptor';
import { configureApp } from '../src/bootstrap/configure-app';

let scope = ['ranges:read'];
let azp = 'mcp-gateway';
let sideEffects = 0;
@Controller('admin/ranges')
@UseGuards(AdminAuthGuard)
class ScopedRangeFixtureController {
  @Get(':id') read() {
    return { id: 'range-1', status: 'running', expiresAt: new Date('2026-10-11T01:00:00Z'),
      runtimeCredentials: { username: 'root', password: 'fixture-canary-secret' },
      accessEntry: { publicIp: '203.0.113.10', ssh: 'fixture-canary-secret' } };
  }
  @Post(':id/destroy') destroy() { sideEffects++; return { accepted: true }; }
}

describe('verified delegated scopes at the actual HTTP boundary', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ScopedRangeFixtureController], providers: [AdminAuthGuard,
      { provide: OidcJwtVerifier, useValue: { verifyAccessToken: async () => ({ issuer: 'https://fixture-issuer', subject: 'sub-1', audience: ['platform-api'], authorizedParty: azp, scopes: scope }) } },
      { provide: OidcPrincipalResolver, useValue: { resolve: async () => ({ id: 'user-1', username: 'fixture', role: 'admin', isPlatformManager: true }) } },
    ] }).compile();
    app = module.createNestApplication(); configureApp(app); app.useGlobalInterceptors(new McpResponseInterceptor()); await app.init();
  });
  beforeEach(() => { scope = ['ranges:read']; azp = 'mcp-gateway'; sideEffects = 0; });
  afterAll(async () => { await app.close(); });

  it('does not let a read-only gateway token reach a destructive controller', async () => {
    await request(app.getHttpServer()).post('/admin/ranges/range-1/destroy').set('Authorization', 'Bearer a.b.c').send({}).expect(403);
    expect(sideEffects).toBe(0);
  });
  it('also enforces explicit business scopes when the signed client is a browser client', async () => {
    azp = 'platform-web';
    await request(app.getHttpServer()).post('/admin/ranges/range-1/destroy').set('Authorization', 'Bearer a.b.c').send({}).expect(403);
    expect(sideEffects).toBe(0);
  });
  it('keeps safe metadata but removes credentials from the HTTP response', async () => {
    const response = await request(app.getHttpServer()).get('/admin/ranges/range-1').set('Authorization', 'Bearer a.b.c').expect(200);
    expect(response.body).toEqual({ id: 'range-1', status: 'running', expiresAt: '2026-10-11T01:00:00.000Z', accessEntry: { publicIp: '203.0.113.10' } });
    expect(JSON.stringify(response.body)).not.toContain('fixture-canary-secret');
  });
  it('accepts the exact operation permission without widening the token', async () => {
    scope = ['ranges:destroy'];
    await request(app.getHttpServer()).post('/admin/ranges/range-1/destroy').set('Authorization', 'Bearer a.b.c').send({}).expect(201);
    expect(sideEffects).toBe(1);
  });
  it('rejects ambiguous authentication before resolving or invoking a controller', async () => {
    await request(app.getHttpServer()).post('/admin/ranges/range-1/destroy').set('Authorization', 'Bearer a.b.c extra').send({}).expect(401);
    expect(sideEffects).toBe(0);
  });
});
