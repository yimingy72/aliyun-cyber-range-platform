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

  it('maps template save and publish lifecycle requests to the editor API', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ input, init });

      if (input.endsWith('/share')) {
        return new Response(
          JSON.stringify({
            operationId: 'operation-publish-1',
            result: {
              result: { id: 'tpl-1', visibility: 'platform', status: 'published', revision: 8 },
            },
          }),
          { status: 200 },
        );
      }

      if (input.endsWith('/unshare')) {
        return new Response(
          JSON.stringify({
            operationId: 'operation-unpublish-1',
            result: { id: 'tpl-1', visibility: 'private', status: 'private', revision: 9 },
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ id: 'tpl-1', visibility: 'platform', revision: 8 }), { status: 200 });
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'token-1', fetch: fetchMock as typeof fetch });

    await expect(
      (client as unknown as {
        saveRangeTemplateTopology: (
          id: string,
          payload: Record<string, unknown>,
          operation: { idempotencyKey: string; confirmationId: string },
        ) => Promise<unknown>;
      }).saveRangeTemplateTopology(
        'tpl-1',
        {
          expectedRevision: 7,
          topologySpec: { vpcCidr: '10.0.0.0/16' },
          topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          scenarioTemplateSpec: {},
          compiledProvisionSpec: {},
          compiledSpec: {},
        },
        { idempotencyKey: 'idem-1', confirmationId: 'confirm-1' },
      ),
    ).resolves.toMatchObject({ id: 'tpl-1', revision: 8 });
    await expect(
      (client as unknown as {
        publishRangeTemplate: (id: string, expectedRevision: number, operation: { idempotencyKey: string; confirmationId: string }) => Promise<unknown>;
      }).publishRangeTemplate('tpl-1', 8, { idempotencyKey: 'idem-1', confirmationId: 'confirm-1' }),
    ).resolves.toEqual({ id: 'tpl-1', visibility: 'platform', status: 'published', revision: 8 });
    await expect(
      (client as unknown as {
        unpublishRangeTemplate: (id: string, expectedRevision: number, operation: { idempotencyKey: string; confirmationId: string }) => Promise<unknown>;
      }).unpublishRangeTemplate('tpl-1', 8, { idempotencyKey: 'idem-1', confirmationId: 'confirm-1' }),
    ).resolves.toEqual({ id: 'tpl-1', visibility: 'private', status: 'private', revision: 9 });

    expect(calls).toEqual([
      expect.objectContaining({
        input: 'https://platform.example/admin/scenarios/tpl-1/validate-and-save',
        init: expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: 7,
            topologySpec: { vpcCidr: '10.0.0.0/16' },
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
            scenarioTemplateSpec: {},
            compiledProvisionSpec: {},
            compiledSpec: {},
          }),
          headers: expect.objectContaining({
            'x-idempotency-key': 'idem-1',
            'x-confirmation-id': 'confirm-1',
          }),
        }),
      }),
      expect.objectContaining({
        input: 'https://platform.example/admin/scenarios/tpl-1/share',
        init: expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ expectedRevision: 8 }),
        }),
      }),
      expect.objectContaining({
        input: 'https://platform.example/admin/scenarios/tpl-1/unshare',
        init: expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ expectedRevision: 8 }),
        }),
      }),
    ]);
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

  it('maps image catalog and billing MCP support requests to the frontend APIs', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      const payload =
        input.includes('/billing/')
          ? input.includes('/export/')
            ? 'billingDate,pretaxAmount\n'
            : input.endsWith('/sync')
              ? { syncedDays: 1, importedLineItems: 2, anomalyCount: 0, deferredCount: 0 }
              : { totalPretaxAmount: 12.5 }
          : input.includes('/image-imports')
            ? input.endsWith('/retry')
              ? { id: 'import-1', status: 'importing' }
              : { items: [{ id: 'import-1', status: 'failed' }] }
            : { snapshots: [{ id: 'snapshot-1' }], catalogItems: [] };

      return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status: 200 });
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'token-1', fetch: fetchMock as typeof fetch });

    await expect(client.listImageCatalog('custom')).resolves.toMatchObject({ snapshots: [{ id: 'snapshot-1' }] });
    await expect(client.syncImageCatalog('public')).resolves.toMatchObject({ snapshots: [{ id: 'snapshot-1' }] });
    await expect(client.listImageImportJobs()).resolves.toMatchObject({ items: [{ id: 'import-1' }] });
    await expect(client.retryImageImport('import-1')).resolves.toMatchObject({ id: 'import-1', status: 'importing' });
    await expect(client.getBillingSummary({ startAt: '2026-07-01', endAt: '2026-07-07' })).resolves.toMatchObject({
      totalPretaxAmount: 12.5,
    });
    await expect(client.syncBilling({ startAt: '2026-07-01', endAt: '2026-07-07' })).resolves.toMatchObject({
      syncedDays: 1,
    });
    await expect(client.exportPlatformBillingCsv({ startAt: '2026-07-01', endAt: '2026-07-07' })).resolves.toBe(
      'billingDate,pretaxAmount\n',
    );

    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ input: 'https://platform.example/admin/image-catalog/custom', init: expect.objectContaining({ method: 'GET' }) }),
        expect.objectContaining({ input: 'https://platform.example/admin/image-catalog/public/sync', init: expect.objectContaining({ method: 'POST' }) }),
        expect.objectContaining({ input: 'https://platform.example/admin/image-imports', init: expect.objectContaining({ method: 'GET' }) }),
        expect.objectContaining({ input: 'https://platform.example/admin/image-imports/import-1/retry', init: expect.objectContaining({ method: 'POST' }) }),
        expect.objectContaining({ input: 'https://platform.example/admin/billing/summary?startAt=2026-07-01&endAt=2026-07-07', init: expect.objectContaining({ method: 'GET' }) }),
        expect.objectContaining({ input: 'https://platform.example/admin/billing/sync', init: expect.objectContaining({ method: 'POST' }) }),
        expect.objectContaining({ input: 'https://platform.example/admin/billing/export/platform.csv?startAt=2026-07-01&endAt=2026-07-07', init: expect.objectContaining({ method: 'GET' }) }),
      ]),
    );
  });
});
