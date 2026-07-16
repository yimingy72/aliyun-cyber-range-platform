import { afterEach, describe, expect, it, vi } from 'vitest';

import { authenticateRequest } from '../src/auth';

describe('authenticateRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MCP_STATIC_BEARER_TOKEN;
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
