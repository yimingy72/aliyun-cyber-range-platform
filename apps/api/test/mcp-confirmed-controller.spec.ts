import { ConflictException } from '@nestjs/common';

import type { AuthenticatedPlatformRequest } from '../src/auth/request-auth-context';
import { RangesController } from '../src/admin/ranges.controller';
import type { RangeInstancesService } from '../src/admin/range-instances.service';
import type { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { SystemConfigController } from '../src/admin/system-config.controller';
import type { SystemConfigService } from '../src/admin/system-config.service';
import { OperationControlService } from '../src/operations/operation-control.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('MCP controller confirmation cycles', () => {
  const user = { id: 'user-1', username: 'alice', role: 'admin' as const };
  const request: AuthenticatedPlatformRequest = {
    headers: {}, adminUser: user,
    authContext: { user, source: 'mcp', oauthClientId: 'mcp-gateway' },
  };

  async function confirm(action: (request: AuthenticatedPlatformRequest) => Promise<unknown>) {
    let confirmationId: string | undefined;
    try {
      await action(request);
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      confirmationId = ((error as ConflictException).getResponse() as { confirmationId: string }).confirmationId;
    }
    expect(confirmationId).toEqual(expect.any(String));
    return action({ ...request, headers: { 'x-confirmation-id': confirmationId } });
  }

  it('submits two separate reboots of the same node through separate confirmations', async () => {
    const run = jest.fn().mockResolvedValue({ status: 'submitted' });
    const controller = new RangesController(
      { prepareActionConfirmation: async () => ({ targetId: 'range-1', targetSnapshot: null, summary: {} }) } as unknown as RangeInstancesService,
      { run } as unknown as RangeInstanceNodeActionsService,
      new OperationControlService(createMemoryAdminRepository()),
    );
    const action = (current: AuthenticatedPlatformRequest) => controller.runNodeAction(current, 'range-1', 'ecs-1', 'reboot', {});
    await confirm(action);
    await confirm(action);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('allows a later cloud configuration update with new arguments and its own confirmation', async () => {
    const updateSnapshot = jest.fn().mockResolvedValue({ accessKeyId: 'test-key', accessKeySecret: 'test-secret' });
    const controller = new SystemConfigController(
      { updateSnapshot } as unknown as SystemConfigService,
      new OperationControlService(createMemoryAdminRepository()),
    );
    await confirm((current) => controller.updateSnapshot(current, { defaultRegion: 'cn-hangzhou' }));
    await confirm((current) => controller.updateSnapshot(current, { defaultRegion: 'cn-shanghai' }));
    expect(updateSnapshot).toHaveBeenCalledTimes(2);
    expect(updateSnapshot).toHaveBeenLastCalledWith({ defaultRegion: 'cn-shanghai' });
  });
});
