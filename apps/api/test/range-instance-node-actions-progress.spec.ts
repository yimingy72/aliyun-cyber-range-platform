import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import type { AdminRepository } from '../src/admin/admin.repository';
import type { SystemConfigService } from '../src/admin/system-config.service';
import type { PackedImagesService } from '../src/admin/packed-images.service';

describe('OpenTofu member progress action guards', () => {
  function fixture(status = 'running', jobType = 'create') {
    const instance = { id: 'member-1', ownerUserId: 'alice', instanceMode: 'single', status: 'running', lastJobId: 'job-1',
      singleInstanceConfig: { executionBackend: 'opentofu', hostKey: 'host-1' }, resourceSummary: { hostIds: { 'host-1': 'i-test' } } };
    const repository = { getRangeInstanceById: jest.fn(async () => instance), getProvisionJobById: jest.fn(async () => ({ status, jobType })) };
    const config = { getAccountContext: jest.fn(async () => { throw new Error('passed-active-create-guard'); }) };
    return { repository, config, service: new RangeInstanceNodeActionsService(repository as unknown as AdminRepository,
      config as unknown as SystemConfigService, {} as PackedImagesService) };
  }
  it.each(['start', 'stop', 'reboot', 'pack-image'])('blocks %s cloud mutations until durable creation finishes', async action => {
    const test = fixture();
    await expect(test.service.run('member-1', 'host-1', action, {}, { id: 'alice', role: 'user' } as never)).rejects.toThrow('实例仍在完成创建');
    expect(test.config.getAccountContext).not.toHaveBeenCalled();
  });
  it('also protects single-instance control routing', async () => {
    const test = fixture();
    test.config.getAccountContext.mockResolvedValueOnce({} as never);
    await expect(test.service.runSingleInstanceAction('member-1', 'reboot', {}, { id: 'alice', role: 'user' } as never)).rejects.toThrow('实例仍在完成创建');
  });
  it('allows read-only VNC to reach its usual checks while a member is early-ready', async () => {
    const test = fixture();
    await expect(test.service.run('member-1', 'host-1', 'open-vnc', {}, { id: 'alice', role: 'user' } as never)).rejects.toThrow('passed-active-create-guard');
  });
  it('allows controls after successful creation', async () => {
    const test = fixture('succeeded');
    await expect(test.service.run('member-1', 'host-1', 'reboot', {}, { id: 'alice', role: 'user' } as never)).rejects.toThrow('passed-active-create-guard');
  });
});
