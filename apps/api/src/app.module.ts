import { Module } from '@nestjs/common';

import { ADMIN_REPOSITORY } from './admin/admin.repository';
import { AdminAuthGuard } from './admin/admin-auth.guard';
import { AdminSessionController } from './admin/admin-session.controller';
import { AdminSessionService } from './admin/admin-session.service';
import { CompetitionsController } from './admin/competitions.controller';
import { CompetitionsService } from './admin/competitions.service';
import { RangeInstancesController } from './admin/range-instances.controller';
import { RangeInstancesService } from './admin/range-instances.service';
import { RangeTemplatesController } from './admin/range-templates.controller';
import { RangeTemplatesService } from './admin/range-templates.service';
import { SystemConfigController } from './admin/system-config.controller';
import { SystemConfigService } from './admin/system-config.service';
import { TeamsController } from './admin/teams.controller';
import { TeamsService } from './admin/teams.service';
import { ProvisionJobsController } from './admin/provision-jobs.controller';
import { ProvisionJobsService } from './admin/provision-jobs.service';
import { AppController } from './app.controller';
import { PrismaAdminRepository } from './database/prisma-admin.repository';
import { PrismaService } from './database/prisma.service';
import { CidrPoolService } from './provisioning/cidr-pool.service';
import { DryRunRangeProvisioner } from './provisioning/dry-run-range-provisioner';
import { createRangeProvisionerFromEnv } from './provisioning/open-tofu-range-provisioner';
import { ProvisioningWorkerService } from './provisioning/provisioning-worker.service';
import { RANGE_PROVISIONER } from './provisioning/provisioning.types';

@Module({
  controllers: [
    AppController,
    AdminSessionController,
    CompetitionsController,
    TeamsController,
    RangeTemplatesController,
    RangeInstancesController,
    ProvisionJobsController,
    SystemConfigController,
  ],
  providers: [
    AdminAuthGuard,
    AdminSessionService,
    CompetitionsService,
    TeamsService,
    RangeTemplatesService,
    RangeInstancesService,
    ProvisionJobsService,
    SystemConfigService,
    CidrPoolService,
    ProvisioningWorkerService,
    PrismaService,
    PrismaAdminRepository,
    DryRunRangeProvisioner,
    {
      provide: ADMIN_REPOSITORY,
      useExisting: PrismaAdminRepository,
    },
    {
      provide: RANGE_PROVISIONER,
      useFactory: () =>
        createRangeProvisionerFromEnv({
          projectRootDir: process.cwd(),
        }),
    },
  ],
})
export class AppModule {}
