import { afterEach, describe, expect, it, vi } from 'vitest';

import { authenticateRequest } from '../src/auth';

describe('authenticateRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MCP_STATIC_BEARER_TOKEN;
  });

  it('rejects configured static credentials', async () => {
    process.env.MCP_STATIC_BEARER_TOKEN = 'shared-static';
    await expect(authenticateRequest({ headers: { authorization: 'Bearer shared-static' } } as never)).resolves.toBeNull();
  });

  it('rejects a legacy platform session token', async () => {
    const request = {
      headers: {
        authorization: 'Bearer legacy-session-token',
      },
    } as never;

    await expect(authenticateRequest(request)).resolves.toBeNull();
  });
});
