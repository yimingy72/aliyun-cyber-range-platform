import { describe, expect, it, vi } from 'vitest';

import { PlatformApiClient, PlatformApiError } from '../src/client';

describe('PlatformApiClient', () => {
  it('loads a range template from the detail endpoint', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe('https://platform.example/admin/scenarios/tpl%2F1');
      expect(init?.method).toBe('GET');

      return new Response(
        JSON.stringify({
          id: 'tpl/1',
          status: 'private',
          revision: 3,
          topologyGraph: { schemaVersion: '2.0.0', nodes: [{ id: 'ecs-1' }], edges: [] },
        }),
        { status: 200 },
      );
    });
    const client = new PlatformApiClient({
      baseUrl: 'https://platform.example',
      token: 'token-1',
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.getRangeTemplate('tpl/1')).resolves.toEqual(
      expect.objectContaining({
        id: 'tpl/1',
        revision: 3,
        topologyGraph: expect.objectContaining({ nodes: [{ id: 'ecs-1' }] }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps template lifecycle requests and operation headers', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe('https://platform.example/admin/scenarios/tpl-1/publish');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe('{}');
      expect((init?.headers as Record<string, string>)['x-idempotency-key']).toBe('idem-1');
      expect((init?.headers as Record<string, string>)['x-confirmation-id']).toBe('confirm-1');
      return new Response(JSON.stringify({ id: 'tpl-1', visibility: 'platform' }), { status: 200 });
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'token-1', fetch: fetchMock as typeof fetch });

    await expect(
      (client as unknown as { publishRangeTemplate: (id: string, operation: { idempotencyKey: string; confirmationId: string }) => Promise<unknown> }).publishRangeTemplate(
        'tpl-1',
        { idempotencyKey: 'idem-1', confirmationId: 'confirm-1' },
      ),
    ).resolves.toEqual({ id: 'tpl-1', visibility: 'platform' });
  });

  it('maps range launch and operation headers', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe('https://platform.example/admin/ranges/launch');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['x-idempotency-key']).toBe('idem-1');
      expect((init?.headers as Record<string, string>)['x-confirmation-id']).toBe('confirm-1');

      return new Response(JSON.stringify({ id: 'range-1' }), { status: 200 });
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example/', token: 'token-1', fetch: fetchMock as typeof fetch });

    await expect(
      client.launchRange(
        { templateId: 'tpl-1', name: 'range-a', expiresAt: '2026-07-20T00:00:00.000Z' },
        { idempotencyKey: 'idem-1', confirmationId: 'confirm-1' },
      ),
    ).resolves.toEqual({ id: 'range-1' });
  });

  it('finds single instance by flattening lists', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/admin/instances?view=active')) {
        return new Response(JSON.stringify({ batches: [], standaloneInstances: [] }), { status: 200 });
      }

      if (input.endsWith('/admin/instances/ins-1/access')) {
        return new Response(
          JSON.stringify({
            ip: '47.1.2.3',
            publicIp: '47.1.2.3',
            privateIp: '10.0.0.8',
            ssh: 'ssh root@47.1.2.3',
            accessEntry: { publicIp: '47.1.2.3', privateIp: '10.0.0.8', ssh: 'ssh root@47.1.2.3' },
            runtimeCredentials: null,
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          batches: [{ batch: { id: 'batch-1' }, instances: [{ id: 'ins-1', accessEntry: { publicIp: '47.1.2.3', privateIp: '10.0.0.8', ssh: 'ssh root@47.1.2.3' } }] }],
          standaloneInstances: [],
        }),
        { status: 200 },
      );
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'token-1', fetch: fetchMock as typeof fetch });

    await expect(client.getSingleInstance('ins-1')).resolves.toEqual({
      id: 'ins-1',
      accessEntry: { publicIp: '47.1.2.3', privateIp: '10.0.0.8', ssh: 'ssh root@47.1.2.3' },
    });
    await expect(client.getSingleInstanceAccess('ins-1')).resolves.toEqual({
      ip: '47.1.2.3',
      publicIp: '47.1.2.3',
      privateIp: '10.0.0.8',
      ssh: 'ssh root@47.1.2.3',
      accessEntry: { publicIp: '47.1.2.3', privateIp: '10.0.0.8', ssh: 'ssh root@47.1.2.3' },
      runtimeCredentials: null,
    });
  });

  it('throws PlatformApiError on failed response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'denied' }), { status: 403 }));
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'token-1', fetch: fetchMock as typeof fetch });

    await expect(client.listRangeInstances()).rejects.toBeInstanceOf(PlatformApiError);
  });

  it('handles no-content delete responses', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'token-1', fetch: fetchMock as typeof fetch });

    await expect(client.removePlatformImage('img-1')).resolves.toBeUndefined();
  });

  it('checks exact single-instance specification availability with a read-only request', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe('https://platform.example/admin/system-config/instance-type-availability?cpu=2&memory=4');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-1');

      return new Response(
        JSON.stringify({
          cpu: 2,
          memory: 4,
          regionId: 'cn-hangzhou',
          zoneId: 'cn-hangzhou-h',
          exactAvailable: true,
          matches: [{ instanceTypeId: 'ecs.e-c1m2.large', cpu: 2, memoryGiB: 4, family: 'ecs.e', generation: 'c1', architecture: 'x86' }],
          warning: null,
        }),
        { status: 200 },
      );
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'token-1', fetch: fetchMock as typeof fetch });

    await expect(client.getInstanceTypeAvailability(2, 4)).resolves.toMatchObject({
      cpu: 2,
      memory: 4,
      exactAvailable: true,
      matches: [{ instanceTypeId: 'ecs.e-c1m2.large' }],
    });
  });
});
