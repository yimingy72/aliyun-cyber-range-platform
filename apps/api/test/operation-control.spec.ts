import { ConflictException } from '@nestjs/common';

import { OperationControlService } from '../src/operations/operation-control.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('OperationControlService', () => {
  const context = {
    user: { id: 'user-1', username: 'alice', role: 'user' as const },
    source: 'mcp' as const,
    oauthClientId: 'mcp-gateway',
  };

  it('generates a fresh key for each implicit operation and binds a keyless replay to its confirmation', async () => {
    const service = new OperationControlService(createMemoryAdminRepository());
    const execute = jest.fn().mockResolvedValue({ status: 'submitted' });
    const input = {
      context,
      metadata: { requestId: 'request-1', idempotencyKey: null, confirmationId: null },
      toolName: 'range_instance_node_reboot', arguments: { rangeInstanceId: 'range-1', nodeId: 'ecs-1' },
      targetType: 'range_instance',
      resolveConfirmation: async () => ({ targetId: 'range-1', targetSnapshot: null, summary: {} }),
      execute,
    };
    const keys: string[] = [];
    for (let request = 0; request < 2; request += 1) {
      const response = await confirmationRequired(() => service.executeConfirmed(input));
      keys.push(response.idempotencyKey);
      const replay = { ...input, metadata: { ...input.metadata, confirmationId: response.confirmationId } };
      await expect(service.executeConfirmed(replay)).resolves.toMatchObject({ status: 'submitted' });
      await expect(service.executeConfirmed(replay)).resolves.toMatchObject({ status: 'succeeded' });
    }
    expect(new Set(keys).size).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(['actor', 'client', 'tool', 'arguments', 'key'])('rejects a confirmation with a different %s', async (changed) => {
    const service = new OperationControlService(createMemoryAdminRepository());
    const execute = jest.fn().mockResolvedValue({ status: 'submitted' });
    const input = {
      context,
      metadata: { requestId: 'request-1', idempotencyKey: 'idem-1', confirmationId: null as string | null },
      toolName: 'range_instance_node_reboot', arguments: { nodeId: 'ecs-1' }, targetType: 'range_instance',
      resolveConfirmation: async () => ({ targetId: 'range-1', targetSnapshot: null, summary: {} }),
      execute,
    };
    const response = await confirmationRequired(() => service.executeConfirmed(input));
    const replay = { ...input, metadata: { ...input.metadata, confirmationId: response.confirmationId } };
    if (changed === 'actor') replay.context = { ...context, user: { ...context.user, id: 'user-2' } };
    if (changed === 'client') replay.context = { ...context, oauthClientId: 'different-client' };
    if (changed === 'tool') replay.toolName = 'range_instance_node_stop';
    if (changed === 'arguments') replay.arguments = { nodeId: 'ecs-2' };
    if (changed === 'key') replay.metadata.idempotencyKey = 'idem-2';
    await expect(service.executeConfirmed(replay)).rejects.toThrow('Operation confirmation does not match this request');
    expect(execute).not.toHaveBeenCalled();
  });

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

async function confirmationRequired(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    const response = (error as ConflictException).getResponse() as {
      code: string; confirmationId: string; idempotencyKey: string;
    };
    expect(response.code).toBe('CONFIRMATION_REQUIRED');
    return response;
  }
  throw new Error('Expected confirmation requirement');
}
