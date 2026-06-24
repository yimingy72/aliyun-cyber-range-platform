import { Injectable } from '@nestjs/common';

@Injectable()
export class CidrPoolService {
  private allocationQueue: Promise<unknown> = Promise.resolve();

  getPool(envValue = process.env.RANGE_CIDR_POOL ?? '') {
    return envValue
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  allocate(pool: string[], occupied: string[]) {
    const match = pool.find((cidr) => !occupied.includes(cidr));

    if (!match) {
      throw new Error('No CIDR available in RANGE_CIDR_POOL');
    }

    return match;
  }

  async serialize<T>(work: () => Promise<T>) {
    const run = this.allocationQueue.then(work, work);

    this.allocationQueue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}
