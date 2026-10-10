import { describe, expect, it, vi } from 'vitest';

import { PlatformApiClient, PlatformApiError } from '../src/client';

describe('PlatformApiClient', () => {
  it('maps a bounded DNS verification to the exact node and preserves operation confirmation', async () => {
    const proof = { status: 'verified', method: 'readback', expected: [], actual: [], resolutionStatus: 'not_requested' };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe('https://platform.example/admin/ranges/range%2F1/nodes/host%2F1/actions/verify-dns');
      expect(init).toMatchObject({ method: 'POST', body: '{}', headers: { 'x-idempotency-key': 'dns-1', 'x-confirmation-id': 'confirm-dns' } });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ status: 'verified', action: 'verify-dns', dnsVerification: proof }));
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture-token', fetch: fetchMock as typeof fetch });
    await expect(client.runRangeInstanceNodeAction('range/1', 'host/1', 'verify-dns', {}, { idempotencyKey: 'dns-1', confirmationId: 'confirm-dns' }))
      .resolves.toMatchObject({ dnsVerification: proof });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('uses a distinct dry-run validation endpoint and preserves bounded diagnostics', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe('https://platform.example/admin/ranges/range%2F1/nodes/node%2F1/pack-image-validation');
      expect(init?.method).toBe('POST'); expect(JSON.parse(init?.body as string)).toEqual({ displayName: 'Exact image', description: 'Exact description' });
      expect(init?.headers).not.toHaveProperty('x-confirmation-id');
      return new Response(JSON.stringify({status:'validated',dryRun:true,cloudRequestId:'dry-run-receipt'}),{status:200});
    });
    const client = new PlatformApiClient({baseUrl:'https://platform.example',token:'mock',fetch:fetchMock as typeof fetch});
    await expect(client.validateRangeInstanceNodePackImage('range/1','node/1',{displayName:'Exact image',description:'Exact description'})).resolves.toMatchObject({dryRun:true,status:'validated'});
  });
  it('maps existing global tag and asset association APIs, passes confirmation headers and unwraps writes', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      if (init?.method === 'GET') return new Response(JSON.stringify({ items: [{ id: 'tag-1', name: 'Web' }] }), { status: 200 });
      return new Response(JSON.stringify({ operationId: 'operation-tags', result: input.endsWith('/tags') ? { id: 'asset/1', tags: [] } : { id: 'tag-2', name: 'API' } }), { status: 200 });
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'mock', fetch: fetchMock as typeof fetch });
    await expect(client.listPlatformImageTags()).resolves.toEqual([{ id: 'tag-1', name: 'Web' }]);
    await expect(client.createPlatformImageTag('API', { idempotencyKey: 'tag-new', confirmationId: 'tag-confirm' })).resolves.toEqual({ id: 'tag-2', name: 'API' });
    await expect(client.setPlatformImageTags('asset/1', [], { idempotencyKey: 'set-tags', confirmationId: 'set-confirm' })).resolves.toMatchObject({ id: 'asset/1', tags: [] });
    expect(calls[1]).toMatchObject({ input: 'https://platform.example/admin/platform-image-tags', init: { method: 'POST', body: JSON.stringify({ name: 'API' }), headers: { 'x-idempotency-key': 'tag-new', 'x-confirmation-id': 'tag-confirm' } } });
    expect(calls[2]).toMatchObject({ input: 'https://platform.example/admin/platform-images/asset%2F1/tags', init: { method: 'PUT', body: JSON.stringify({ tagIds: [] }), headers: { 'x-idempotency-key': 'set-tags', 'x-confirmation-id': 'set-confirm' } } });
  });

  it.each([undefined, false, true])('only requests range network diagnostics when explicitly true (%s)', async (includeNetworkDiagnostics) => {
    const snapshot = { id: 'range/1', status: 'running', ...(includeNetworkDiagnostics === true ? {
      networkDiagnostics: {
        status: 'succeeded', checkedAt: '2026-10-09T00:00:00Z', regionId: 'cn-hangzhou',
        cloudAccountUid: 'mock-account', vpcId: 'vpc-mock', instances: [], networkInterfaces: [],
        natGateways: [], forwardEntries: [], snatEntries: [], routeTables: [], networkAcls: [], securityGroups: [],
      },
    } : {}) };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe(`https://platform.example/admin/ranges/range%2F1${includeNetworkDiagnostics === true ? '?includeNetworkDiagnostics=true' : ''}`);
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify(snapshot), { status: 200 });
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'mock', fetch: fetchMock as typeof fetch });

    await expect(client.getRangeInstance('range/1', includeNetworkDiagnostics === undefined
      ? undefined : { includeNetworkDiagnostics })).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes an explicit owned-snapshot cleanup flag and confirmation metadata and returns verified progress', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe('https://platform.example/admin/image-catalog/custom/source%2Fnew?deleteOwnedSnapshots=true');
      expect(init?.method).toBe('DELETE');
      expect(init?.headers).toMatchObject({ 'x-idempotency-key': 'cleanup-new', 'x-confirmation-id': 'confirmed-new' });
      return new Response(JSON.stringify({ operationId: 'operation-1', result: { result: { removed: true, status: 'deleted', snapshotIds: ['s-new'] } } }), { status: 200 });
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'mock', fetch: fetchMock as typeof fetch });
    await expect(client.removeCustomImageSnapshot('source/new', { deleteOwnedSnapshots: true }, { idempotencyKey: 'cleanup-new', confirmationId: 'confirmed-new' })).resolves.toMatchObject({ removed: true, status: 'deleted', snapshotIds: ['s-new'] });
  });

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
        returnRangeTemplateToPrivate: (id: string, expectedRevision: number, operation: { idempotencyKey: string; confirmationId: string }) => Promise<unknown>;
      }).returnRangeTemplateToPrivate('tpl-1', 8, { idempotencyKey: 'idem-1', confirmationId: 'confirm-1' }),
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

  it('sends the exact expected range draft revision when applying an instance draft', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe('https://platform.example/admin/ranges/range-1/apply');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ expectedDraftRevision: 8, previewToken: 'preview-8' }));
      expect((init?.headers as Record<string, string>)['x-idempotency-key']).toBe('apply-range-1-revision-8');
      expect((init?.headers as Record<string, string>)['x-confirmation-id']).toBe('confirm-apply-1');

      return new Response(JSON.stringify({ id: 'job-1', jobType: 'update' }), { status: 200 });
    });
    const client = new PlatformApiClient({
      baseUrl: 'https://platform.example',
      token: 'token-1',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      (client as unknown as {
        applyRangeInstanceDraft: (
          id: string,
          expectedDraftRevision: number,
          previewToken: string,
          operation: { idempotencyKey: string; confirmationId: string },
        ) => Promise<unknown>;
      }).applyRangeInstanceDraft(
        'range-1',
        8,
        'preview-8',
        { idempotencyKey: 'apply-range-1-revision-8', confirmationId: 'confirm-apply-1' },
      ),
    ).resolves.toEqual({ id: 'job-1', jobType: 'update' });
  });

  it('sends both instance and template revisions when syncing a template draft', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe('https://platform.example/admin/ranges/range-1/sync-template');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(
        JSON.stringify({
          expectedDraftRevision: 8,
          expectedTemplateRevision: 13,
        }),
      );
      expect((init?.headers as Record<string, string>)['x-idempotency-key']).toBe('sync-range-1-revision-8');
      expect((init?.headers as Record<string, string>)['x-confirmation-id']).toBe('confirm-sync-1');

      return new Response(JSON.stringify({ id: 'template-1', revision: 14 }), { status: 200 });
    });
    const client = new PlatformApiClient({
      baseUrl: 'https://platform.example',
      token: 'token-1',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      (client as unknown as {
        syncRangeInstanceTemplate: (
          id: string,
          expectedDraftRevision: number,
          expectedTemplateRevision: number,
          operation: { idempotencyKey: string; confirmationId: string },
        ) => Promise<unknown>;
      }).syncRangeInstanceTemplate(
        'range-1',
        8,
        13,
        { idempotencyKey: 'sync-range-1-revision-8', confirmationId: 'confirm-sync-1' },
      ),
    ).resolves.toEqual({ id: 'template-1', revision: 14 });
  });

  it('reads exact single instance detail instead of losing its safe diagnostics in list projections', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/admin/instances/ins-1')) {
        return new Response(JSON.stringify({ id: 'ins-1', accessEntry: { publicIp: '47.1.2.3', privateIp: '10.0.0.8', ssh: 'ssh root@47.1.2.3' } }), { status: 200 });
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

      throw new Error('Unexpected broad single instance list lookup');
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

  it.each([404, 403, 401])('maps only single detail 404 to null and never retries broad lists for status %s', async status => {
    const fetchMock = vi.fn(async (_request: unknown) => new Response(JSON.stringify({ message: 'fixture rejection' }), { status }));
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture-token', fetch: fetchMock as typeof fetch });
    if (status === 404) await expect(client.getSingleInstance('id/with-space')).resolves.toBeNull();
    else await expect(client.getSingleInstance('id/with-space')).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://platform.example/admin/instances/id%2Fwith-space');
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
              : { totalPretaxAmount: 12.5, billingScope: 'platform_resources', billingStatus: 'provisional', resourcesWithoutBillCount: 3,
                  reconciliationIssues: [{ resourceType: 'oss', resourceCount: 1, reason: 'Awaiting ownership proof' }],
                  unallocatedCurrencyTotals: [{ currency: 'USD', pretaxAmount: 2 }] }
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
      billingScope: 'platform_resources',
      billingStatus: 'provisional',
      reconciliationIssues: [{ resourceType: 'oss', resourceCount: 1, reason: 'Awaiting ownership proof' }],
      resourcesWithoutBillCount: 3,
      unallocatedCurrencyTotals: [{ currency: 'USD', pretaxAmount: 2 }],
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
