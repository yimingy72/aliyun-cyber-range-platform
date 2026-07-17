import { ConflictException } from '@nestjs/common';

import { OperationControlService } from '../src/operations/operation-control.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('OperationControlService', () => {
  it('requires one matching confirmation and reuses an idempotent result', async () => {
    const repository = createMemoryAdminRepository();
    const service = new OperationControlService(repository);
    const execute = jest.fn().mockResolvedValue({ batchId: 'batch-1' });
    const input = {
      context: {
        user: { id: 'user-1', username: 'alice', role: 'user' as const },
        source: 'mcp' as const,
        oauthClientId: 'mcp-gateway',
      },
      metadata: { requestId: 'request-1', idempotencyKey: 'idem-1', confirmationId: null },
      toolName: 'single_instance_batch_launch',
      arguments: { name: 'exercise', password: 'secret' },
      targetType: 'single_instance_batch',
      resolveConfirmation: jest.fn().mockResolvedValue({
        targetId: 'image-1',
        targetSnapshot: { imageId: 'image-1' },
        summary: { targetName: 'exercise' },
      }),
      execute,
    };

    let confirmationId: string;
    try {
      await service.executeConfirmed(input);
      throw new Error('expected confirmation requirement');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const response = (error as ConflictException).getResponse() as { confirmationId: string; idempotencyKey: string };
      confirmationId = response.confirmationId;
      expect(response.idempotencyKey).toBe('idem-1');
    }

    await expect(
      service.executeConfirmed({ ...input, metadata: { ...input.metadata, confirmationId: confirmationId! } }),
    ).resolves.toMatchObject({ batchId: 'batch-1' });

    await expect(
      service.executeConfirmed({ ...input, metadata: { ...input.metadata, confirmationId: null } }),
    ).resolves.toMatchObject({ status: 'succeeded', result: { batchId: 'batch-1' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
