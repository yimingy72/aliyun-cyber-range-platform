import { Module } from '@nestjs/common';
import path from 'node:path';

import { ADMIN_REPOSITORY } from './admin/admin.repository';
import { AdminAuthGuard } from './admin/admin-auth.guard';
import { ImageCatalogController } from './admin/image-catalog.controller';
import { ImageCatalogService } from './admin/image-catalog.service';
import { PlatformImagesController } from './admin/platform-images.controller';
import { AdminSessionController } from './admin/admin-session.controller';
import { AdminSessionService } from './admin/admin-session.service';
import { RangeInstancesService } from './admin/range-instances.service';
import { RangesController } from './admin/ranges.controller';
import { RangeTemplatesService } from './admin/range-templates.service';
import { ScenariosController } from './admin/scenarios.controller';
import { SystemConfigController } from './admin/system-config.controller';
import { SystemConfigService } from './admin/system-config.service';
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
    ScenariosController,
    RangesController,
    ProvisionJobsController,
    SystemConfigController,
    ImageCatalogController,
    PlatformImagesController,
  ],
  providers: [
    AdminAuthGuard,
    ImageCatalogService,
    AdminSessionService,
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
          projectRootDir: path.resolve(__dirname, '..', '..', '..'),
        }),
    },
  ],
})
export class AppModule {}
