import type { AdminRepository } from '../src/admin/admin.repository';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { SingleInstanceNetworkService } from '../src/admin/single-instance-network.service';
import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { SingleInstancesService } from '../src/admin/single-instances.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { ProvisioningWorkerService } from '../src/provisioning/provisioning-worker.service';

describe('SingleInstancesService', () => {
  it('rejects a launch whose expiration time is already in the past before preparing cloud resources', async () => {
    const ensureDefaultProfile = jest.fn();
    const service = new SingleInstancesService(
      {} as AdminRepository,
      {} as SystemConfigService,
      { ensureDefaultProfile } as unknown as SingleInstanceNetworkService,
      {} as SingleInstanceBatchExecutionService,
      {} as ProvisioningWorkerService,
      {} as RangeInstanceNodeActionsService,
    );

    await expect(
      service.launch(
        {
          name: 'expired-single',
          platformImageAssetId: 'asset-1',
          cpu: 2,
          memory: 2,
          quantity: 1,
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
        'user-1',
      ),
    ).rejects.toThrow('到期时间');
    expect(ensureDefaultProfile).not.toHaveBeenCalled();
  });
});
