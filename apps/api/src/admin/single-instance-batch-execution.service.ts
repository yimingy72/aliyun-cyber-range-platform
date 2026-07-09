import { Inject, Injectable } from '@nestjs/common';

import { ADMIN_REPOSITORY, type AdminRepository } from './admin.repository';
import { SystemConfigService } from './system-config.service';

@Injectable()
export class SingleInstanceBatchExecutionService {
  private readonly maxConcurrency = 3;
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async runWithSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.inFlight += 1;

    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.queue.shift()?.();
    }
  }

  async runCreateBatch<T>(work: () => Promise<T>) {
    return this.runWithSlot(work);
  }

  async runDestroyBatch<T>(work: () => Promise<T>) {
    return this.runWithSlot(work);
  }
}
