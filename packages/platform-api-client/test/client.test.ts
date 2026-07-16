import { describe, expect, it, vi } from 'vitest';

import { PlatformApiClient, PlatformApiError } from '../src/client';

describe('PlatformApiClient', () => {
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

      return new Response(
        JSON.stringify({
          batches: [{ batch: { id: 'batch-1' }, instances: [{ id: 'ins-1', defaultInstancePassword: 'p' }] }],
          standaloneInstances: [],
        }),
        { status: 200 },
      );
    });
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'token-1', fetch: fetchMock as typeof fetch });

    await expect(client.getSingleInstance('ins-1')).resolves.toEqual({ id: 'ins-1', defaultInstancePassword: 'p' });
    await expect(client.getSingleInstanceAccess('ins-1')).resolves.toEqual({
      defaultInstancePassword: 'p',
      accessEntry: null,
      runtimeCredentials: null,
    });
  });

  it('throws PlatformApiError on failed response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'denied' }), { status: 403 }));
    const client = new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'token-1', fetch: fetchMock as typeof fetch });

    await expect(client.listRangeInstances()).rejects.toBeInstanceOf(PlatformApiError);
  });
});
