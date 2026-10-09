import { Logger } from '@nestjs/common';
import { ImageImportsWorkerService } from '../src/admin/image-imports-worker.service';
import { getCurrentCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';

describe('independent image bucket recovery polling', () => {
  afterEach(() => jest.restoreAllMocks());
  it('still polls bucket records when import job polling fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let observed!: () => void;
    const reached = new Promise<void>(resolve => { observed = resolve; });
    const service = {
      refreshPendingImports: jest.fn(async () => { throw new Error('synthetic import failure'); }),
      refreshManagedBuckets: jest.fn(async () => {
        expect(getCurrentCloudWorkspaceScope()).toEqual({ system: true });
        observed();
        return new Promise<void>(() => undefined);
      }),
    };
    const worker = new ImageImportsWorkerService(service as never);
    void worker.runLoop();
    await reached;
    expect(service.refreshManagedBuckets).toHaveBeenCalledTimes(1);
    expect(service.refreshPendingImports).toHaveBeenCalledTimes(1);
  });
});
