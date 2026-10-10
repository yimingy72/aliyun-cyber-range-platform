import { ForbiddenException, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

import { Prisma, PrismaClient } from '@aliyun-cyber-range/database/generated/client';
import { getCurrentCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { scopePrismaQuery, scopePrismaResult } from './prisma-workspace-scope';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Optional() options?: Prisma.PrismaClientOptions) {
    super(options);
    const scoped = this.$extends({
      name: 'cloud-workspace-isolation',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const scope = getCurrentCloudWorkspaceScope();
            if (!scope && process.env.NODE_ENV !== 'test'
              && !['CloudWorkspace', 'CloudAccountContext', 'SystemCloudConfig'].includes(model)) {
              throw new ForbiddenException('Cloud workspace scope is required');
            }
            const result = await query(scopePrismaQuery(model, operation, args, scope) as typeof args);
            return scopePrismaResult(model, result, args, scope);
          },
        },
      },
    });
    // Keep Nest lifecycle methods while transactions and delegates use the same scoped client.
    return new Proxy(this, {
      get(target, property, receiver) {
        if (property in scoped && !['onModuleInit', 'onModuleDestroy', 'constructor'].includes(String(property))) {
          const value = Reflect.get(scoped, property);
          return typeof value === 'function' ? value.bind(scoped) : value;
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  async onModuleInit() {
    if (process.env.NODE_ENV !== 'test') {
      await this.$connect();
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
