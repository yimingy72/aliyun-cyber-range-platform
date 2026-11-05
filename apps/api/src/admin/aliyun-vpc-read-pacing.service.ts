import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../database/prisma.service';

export class VpcReadBudgetTimeout extends Error {
  constructor() { super('PLATFORM_VPC_READ_BUDGET_TIMEOUT'); }
}
export const vpcReadGap = (action: string) => action === 'DescribeNetworkAcls' || action === 'DescribeNetworkAclAttributes' ? 3000 : 1000;

@Injectable()
export class AliyunVpcReadPacingService {
  constructor(private readonly prisma: PrismaService) {}

  private keys(accountUid: string, action: string) {
    if (!/^\d{1,32}$/.test(accountUid) || !/^Describe[A-Za-z0-9]+$/.test(action)) throw new Error('INVALID_VPC_READ_BUDGET_IDENTITY');
    return [`alibaba:vpc:${accountUid}:all`, `alibaba:vpc:${accountUid}:${action.startsWith('DescribeNetworkAcl')?'network_acl':action}`].sort();
  }

  // Claim only an immediately usable slot. Sleeping outside the transaction avoids holding
  // connections, and rechecking after sleep prevents queued callers bursting after cooldown.
  async tryAcquire(accountUid: string, action: string): Promise<number> {
    const keys = this.keys(accountUid, action);
    return this.prisma.$transaction(async tx => {
      for (const key of keys) await tx.$executeRaw`INSERT INTO "CloudApiReadBudget" ("key") VALUES (${key}) ON CONFLICT DO NOTHING`;
      const rows = await tx.$queryRaw<Array<{ key: string; nextAt: Date }>>`
        SELECT "key", "nextAt" FROM "CloudApiReadBudget"
        WHERE "key" IN (${keys[0]}, ${keys[1]}) ORDER BY "key" FOR UPDATE`;
      if (rows.length !== 2) throw new Error('INCOMPLETE_VPC_READ_BUDGET');
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = clock.now.getTime();
      const wait = Math.max(0, ...rows.map(row => row.nextAt.getTime() - now));
      if (wait > 0) return Math.ceil(wait);
      for (const row of rows) {
        const nextAt = new Date(now + (row.key.endsWith(':all') ? 1000 : vpcReadGap(action)));
        await tx.$executeRaw`UPDATE "CloudApiReadBudget" SET "nextAt"=${nextAt}, "updatedAt"=clock_timestamp() WHERE "key"=${row.key}`;
      }
      return 0;
    });
  }

  async wait(accountUid: string, action: string, deadline = Date.now() + 120_000): Promise<void> {
    for (;;) {
      if (Date.now() >= deadline) throw new VpcReadBudgetTimeout();
      const delay = await this.tryAcquire(accountUid, action);
      if (delay === 0) return;
      if (delay >= deadline - Date.now()) throw new VpcReadBudgetTimeout();
      await sleep(delay + 1);
    }
  }

  async cooldown(accountUid: string, delayMs: number): Promise<void> {
    this.keys(accountUid, 'DescribeVpcs');
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 86_400_000) throw new Error('INVALID_VPC_READ_COOLDOWN');
    const key = `alibaba:vpc:${accountUid}:all`;
    await this.prisma.$executeRaw`
      INSERT INTO "CloudApiReadBudget" ("key", "nextAt") VALUES (${key}, clock_timestamp() + ${delayMs} * interval '1 millisecond')
      ON CONFLICT ("key") DO UPDATE SET "nextAt"=GREATEST("CloudApiReadBudget"."nextAt", EXCLUDED."nextAt"), "updatedAt"=clock_timestamp()`;
  }
}
