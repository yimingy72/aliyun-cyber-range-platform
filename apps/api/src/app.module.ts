import { Module } from '@nestjs/common';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ADMIN_REPOSITORY } from './admin/admin.repository';
import { AdminAuthGuard } from './admin/admin-auth.guard';
import { ImageCatalogController } from './admin/image-catalog.controller';
import { ImageCatalogService } from './admin/image-catalog.service';
import { BillingBssClient } from './admin/billing-bss-client';
import { BillingController } from './admin/billing.controller';
import { BillingService } from './admin/billing.service';
import { BillingSyncService } from './admin/billing-sync.service';
import { PlatformImagesController } from './admin/platform-images.controller';
import { AdminUsersController } from './admin/admin-users.controller';
import { AdminUsersService } from './admin/admin-users.service';
import { KeycloakAdminService } from './admin/keycloak-admin.service';
import { OidcJwtVerifier } from './admin/oidc-jwt-verifier';
import { OidcPrincipalResolver } from './admin/oidc-principal-resolver';
import { RangeInstancesService } from './admin/range-instances.service';
import { RangeInstanceNodeActionsService } from './admin/range-instance-node-actions.service';
import { RangesController } from './admin/ranges.controller';
import { RangeTemplatesService } from './admin/range-templates.service';
import { ScenariosController } from './admin/scenarios.controller';
import { SystemConfigController } from './admin/system-config.controller';
import { SystemConfigService } from './admin/system-config.service';
import { ProvisionJobsController } from './admin/provision-jobs.controller';
import { ProvisionJobsService } from './admin/provision-jobs.service';
import { SingleInstanceNetworkService } from './admin/single-instance-network.service';
import { SingleInstanceBatchExecutionService } from './admin/single-instance-batch-execution.service';
import { SingleInstancesController } from './admin/single-instances.controller';
import { SingleInstancesService } from './admin/single-instances.service';
import { AppController } from './app.controller';
import { PrismaAdminRepository } from './database/prisma-admin.repository';
import { PrismaService } from './database/prisma.service';
import { OidcAdminBootstrapService } from './oidc-admin-bootstrap.service';
import { OperationControlService } from './operations/operation-control.service';
import { CidrPoolService } from './provisioning/cidr-pool.service';
import { DryRunRangeProvisioner } from './provisioning/dry-run-range-provisioner';
import { createRangeProvisionerFromEnv } from './provisioning/open-tofu-range-provisioner';
import { ProvisioningWorkerService } from './provisioning/provisioning-worker.service';
import { RANGE_PROVISIONER } from './provisioning/provisioning.types';
import { SingleInstanceNetworkBootstrapService } from './provisioning/single-instance-network-bootstrap';

function resolveProjectRootDir() {
  let currentDir = process.cwd();

  while (true) {
    if (existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return process.cwd();
    }

    currentDir = parentDir;
  }
}

@Module({
  controllers: [
    AppController,
    AdminUsersController,
    ScenariosController,
    RangesController,
    ProvisionJobsController,
    SystemConfigController,
    ImageCatalogController,
    BillingController,
    PlatformImagesController,
    SingleInstancesController,
  ],
  providers: [
    AdminAuthGuard,
    BillingBssClient,
    ImageCatalogService,
    BillingService,
    BillingSyncService,
    AdminUsersService,
    KeycloakAdminService,
    OidcJwtVerifier,
    OidcPrincipalResolver,
    RangeTemplatesService,
    RangeInstancesService,
    RangeInstanceNodeActionsService,
    SingleInstanceBatchExecutionService,
    SingleInstancesService,
    SingleInstanceNetworkService,
    ProvisionJobsService,
    SystemConfigService,
    CidrPoolService,
    SingleInstanceNetworkBootstrapService,
    ProvisioningWorkerService,
    OidcAdminBootstrapService,
    OperationControlService,
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
          projectRootDir: resolveProjectRootDir(),
        }),
    },
  ],
})
export class AppModule {}
