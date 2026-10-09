import { ConflictException } from '@nestjs/common';

import { OperationControlService } from '../src/operations/operation-control.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
const workspace = { cloudWorkspaceId: 'workspace-a', provider: 'alibaba_cloud' as const, accountUid: 'synthetic-account-a' };

describe('OperationControlService', () => {
  const context = {
    user: { id: 'user-1', username: 'alice', role: 'user' as const },
    source: 'mcp' as const,
    oauthClientId: 'mcp-gateway',
  };

  it('generates a fresh key for each implicit operation and binds a keyless replay to its confirmation', async () => runInCloudWorkspace(workspace, async () => {
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
  }));

  it.each(['actor', 'client', 'tool', 'arguments', 'key'])('rejects a confirmation with a different %s', async (changed) => runInCloudWorkspace(workspace, async () => {
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
  }));

  it('requires one matching confirmation and reuses an idempotent result', async () => runInCloudWorkspace(workspace, async () => {
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
  }));

  it('rejects a confirmation replay after changing workspace and binds audits to the selected account', async () => {
    const base = createMemoryAdminRepository();
    const audit = jest.fn(base.appendOperationAuditEvent);
    const repository = { ...base, appendOperationAuditEvent: audit };
    const service = new OperationControlService(repository);
    const execute = jest.fn().mockResolvedValue({ status: 'submitted' });
    const input = {
      context, metadata: { requestId: 'request-cross-space', idempotencyKey: 'same-key', confirmationId: null as string | null },
      toolName: 'range_instance_destroy', arguments: { rangeInstanceId: 'range-a' }, targetType: 'range_instance',
      resolveConfirmation: async () => ({ targetId: 'range-a', targetSnapshot: null, summary: {} }), execute,
    };
    const required = await runInCloudWorkspace(workspace, () => confirmationRequired(() => service.executeConfirmed(input)));
    await expect(runInCloudWorkspace({ ...workspace, cloudWorkspaceId: 'workspace-b' }, () => service.executeConfirmed({
      ...input, metadata: { ...input.metadata, confirmationId: required.confirmationId },
    }))).rejects.toThrow('Operation confirmation does not match this request');
    expect(execute).not.toHaveBeenCalled();
    expect(audit.mock.calls.map(([row]) => row.cloudWorkspaceId)).toEqual(['workspace-a', 'workspace-a', 'workspace-b']);
  });

  it('runs the same explicit idempotency key independently in two account workspaces', async () => {
    const service = new OperationControlService(createMemoryAdminRepository());
    const execute = jest.fn().mockResolvedValue({ status: 'submitted' });
    const input = {
      context, metadata: { requestId: 'request-1', idempotencyKey: 'shared-key', confirmationId: null as string | null },
      toolName: 'admin_user_create', arguments: { username: 'alice' }, targetType: 'platform_user',
      resolveConfirmation: async () => ({ targetId: null, targetSnapshot: null, summary: {} }), execute,
    };
    for (const cloudWorkspaceId of ['workspace-a', 'workspace-b']) {
      await runInCloudWorkspace({ ...workspace, cloudWorkspaceId }, async () => {
        const required = await confirmationRequired(() => service.executeConfirmed(input));
        await service.executeConfirmed({ ...input, metadata: { ...input.metadata, confirmationId: required.confirmationId } });
        await expect(service.executeConfirmed(input)).resolves.toMatchObject({ status: 'succeeded' });
      });
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects a forged audit workspace even when its actor is unchanged', async () => {
    const base = createMemoryAdminRepository();
    const audit = jest.fn(base.appendOperationAuditEvent);
    const repository = { ...base, appendOperationAuditEvent: audit };
    const service = new OperationControlService(repository);
    await expect(runInCloudWorkspace(workspace, () => service.audit({
      cloudWorkspaceId: 'workspace-b', operationId: 'operation-a', requestId: 'request-a', actorUserId: context.user.id,
      source: 'mcp', toolName: 'admin_user_create', phase: 'requested',
    }))).rejects.toThrow('Operation audit does not match the current cloud workspace');
    expect(audit).not.toHaveBeenCalled();
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
