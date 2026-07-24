import { PlatformImagesController } from '../src/admin/platform-images.controller';

describe('PlatformImagesController', () => {
  it('uses a new request-scoped idempotency key for a new MCP image removal', async () => {
    const imageCatalogService = {
      removePlatformAsset: jest.fn().mockResolvedValue(undefined),
    };
    const operationControlService = {
      executeConfirmed: jest.fn().mockResolvedValue({}),
    };
    const controller = new PlatformImagesController(
      imageCatalogService as never,
      operationControlService as never,
    );

    await controller.remove(
      {
        headers: {},
        adminUser: { id: 'admin-1', username: 'admin', role: 'admin' },
        authContext: {
          source: 'mcp',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
          oauthClientId: 'mcp-client',
        },
      } as never,
      'asset-1',
    );

    expect(operationControlService.executeConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^platform_image_remove:asset-1:[0-9a-f-]{36}$/),
        }),
      }),
    );
  });
});
