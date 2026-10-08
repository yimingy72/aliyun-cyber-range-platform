import { ConflictException } from '@nestjs/common';

import { PlatformImagesController } from '../src/admin/platform-images.controller';
import { OperationControlService } from '../src/operations/operation-control.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('PlatformImagesController', () => {
  it('uses a new request-scoped idempotency key for a new MCP image removal', async () => {
    const imageCatalogService = {
      removePlatformAsset: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new PlatformImagesController(
      imageCatalogService as never,
      new OperationControlService(createMemoryAdminRepository()),
    );

    async function confirmedRemoval() {
      const request = {
        headers: {},
        adminUser: { id: 'admin-1', username: 'admin', role: 'admin' },
        authContext: {
          source: 'mcp',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
          oauthClientId: 'mcp-client',
        },
      };
      let confirmationId: string | undefined;
      try {
        await controller.remove(request as never, 'asset-1');
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        confirmationId = ((error as ConflictException).getResponse() as { confirmationId: string }).confirmationId;
      }
      expect(confirmationId).toEqual(expect.any(String));
      return controller.remove({ ...request, headers: { 'x-confirmation-id': confirmationId } } as never, 'asset-1');
    }

    const first = await confirmedRemoval() as { operationId: string };
    const second = await confirmedRemoval() as { operationId: string };
    expect(first.operationId).not.toBe(second.operationId);
    expect(imageCatalogService.removePlatformAsset).toHaveBeenCalledTimes(2);
  });
});
