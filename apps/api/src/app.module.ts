import { RangeDnsVerificationService } from './admin/range-dns-verification.service';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ADMIN_REPOSITORY } from './admin/admin.repository';
import { AdminAuthGuard } from './admin/admin-auth.guard';
import { RangeInstanceModeGuard } from './admin/range-instance-mode.guard';
import { ImageCatalogController } from './admin/image-catalog.controller';
import { PlatformContainerImagesController } from './admin/platform-container-images.controller';
import { PlatformContainerImagesService } from './admin/platform-container-images.service';
import { ImageCatalogService } from './admin/image-catalog.service';
import { TencentCloudCatalogController } from './admin/tencent-cloud-catalog.controller';
import { TencentCloudCatalogService } from './admin/tencent-cloud-catalog.service';
import { CloudAccountContextsController } from './admin/cloud-account-contexts.controller';
import { CloudAccountContextsService } from './admin/cloud-account-contexts.service';
import { CloudWorkspacesService } from './admin/cloud-workspaces.service';
import { CloudWorkspacesController, PlatformSessionController } from './admin/cloud-workspaces.controller';
import { CloudWorkspaceInterceptor } from './auth/cloud-workspace.interceptor';
import { McpResponseInterceptor } from './auth/mcp-response.interceptor';
import { ImageImportsController } from './admin/image-imports.controller';
import { ImageImportsService } from './admin/image-imports.service';
import { TencentCosManagedBucketService, TENCENT_COS_BUCKETS } from './admin/tencent-cos-managed-bucket.service';
import { ImageImportsWorkerService } from './admin/image-imports-worker.service';
import { PackedImagesService } from './admin/packed-images.service';
import { PackedImagesWorkerService } from './admin/packed-images-worker.service';
import { BillingBssClient } from './admin/billing-bss-client';
import { BillingController } from './admin/billing.controller';
import { BillingService } from './admin/billing.service';
import { TencentBillingClient } from './admin/tencent-billing-client';
import { BillingSyncService } from './admin/billing-sync.service';
import { BillingOssBindingController } from './admin/billing-oss-binding.controller';
import { BillingOssBindingService } from './admin/billing-oss-binding.service';
import { AliyunOssManagedBucketService } from './admin/aliyun-oss-managed-bucket.service';
import { ResourceAlertsController } from './admin/resource-alerts.controller';
import { ResourceAlertsService } from './admin/resource-alerts.service';
import { ResourcePatrolRepository } from './admin/resource-patrol.repository';
import { ResourcePatrolCloudClient } from './admin/resource-patrol-cloud-client';
import { ResourceAlertReclaimer } from './admin/resource-alert-reclaimer';
import { PlatformImagesController } from './admin/platform-images.controller';
import { PlatformImageTagsController } from './admin/platform-image-tags.controller';
import { AdminUsersController } from './admin/admin-users.controller';
import { AdminUsersService } from './admin/admin-users.service';
import { KeycloakAdminService } from './admin/keycloak-admin.service';
import { OidcJwtVerifier } from './admin/oidc-jwt-verifier';
import { OidcPrincipalResolver } from './admin/oidc-principal-resolver';
import { RangeInstancesService } from './admin/range-instances.service';
import { RangeNetworkDiagnosticsService } from './admin/range-network-diagnostics.service';
import { RangeInstanceNodeActionsService } from './admin/range-instance-node-actions.service';
import { RangesController } from './admin/ranges.controller';
import { RangeTemplatesService } from './admin/range-templates.service';
import { ScenariosController } from './admin/scenarios.controller';
import { SystemConfigController } from './admin/system-config.controller';
import { SystemConfigService } from './admin/system-config.service';
import { ProvisionJobsController } from './admin/provision-jobs.controller';
import { ProvisionJobsService } from './admin/provision-jobs.service';
import { SingleInstanceNetworkService } from './admin/single-instance-network.service';
import { SingleInstanceOpenTofuExecutionService } from './admin/single-instance-opentofu-execution.service';
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
import {
  AliyunEcsResourceClient,
  PlatformResourceReconciliationService,
} from './provisioning/platform-resource-reconciliation.service';
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
    CloudAccountContextsController,
    CloudWorkspacesController,
    PlatformSessionController,
    ImageCatalogController,
    PlatformContainerImagesController,
    TencentCloudCatalogController,
    ImageImportsController,
    BillingController,
    BillingOssBindingController,
    ResourceAlertsController,
    PlatformImagesController,
    PlatformImageTagsController,
    SingleInstancesController,
  ],
  providers: [
    AdminAuthGuard,
    RangeInstanceModeGuard,
    BillingBssClient,
    ImageCatalogService,
    PlatformContainerImagesService,
    TencentCloudCatalogService,
    CloudAccountContextsService,
    CloudWorkspacesService,
    { provide: APP_INTERCEPTOR, useClass: CloudWorkspaceInterceptor },
    { provide: APP_INTERCEPTOR, useClass: McpResponseInterceptor },
    ImageImportsService,
    TencentCosManagedBucketService,
    { provide: TENCENT_COS_BUCKETS, useExisting: TencentCosManagedBucketService },
    ImageImportsWorkerService,
    PackedImagesService,
    PackedImagesWorkerService,
    BillingService,
    BillingSyncService,
    BillingOssBindingService,
    AliyunOssManagedBucketService,
    ResourceAlertsService,
    ResourcePatrolRepository,
    ResourcePatrolCloudClient,
    ResourceAlertReclaimer,
    TencentBillingClient,
    AdminUsersService,
    KeycloakAdminService,
    OidcJwtVerifier,
    OidcPrincipalResolver,
    RangeTemplatesService,
    RangeInstancesService,
    RangeNetworkDiagnosticsService,
    RangeInstanceNodeActionsService,
    RangeDnsVerificationService,
    SingleInstanceBatchExecutionService,
    {
      provide: SingleInstanceOpenTofuExecutionService,
      useFactory: (repository: PrismaAdminRepository, config: SystemConfigService, native: SingleInstanceBatchExecutionService) =>
        new SingleInstanceOpenTofuExecutionService(repository, config, native, { projectRootDir: resolveProjectRootDir() }),
      inject: [ADMIN_REPOSITORY, SystemConfigService, SingleInstanceBatchExecutionService],
    },
    SingleInstancesService,
    SingleInstanceNetworkService,
    ProvisionJobsService,
    SystemConfigService,
    CidrPoolService,
    SingleInstanceNetworkBootstrapService,
    AliyunEcsResourceClient,
    PlatformResourceReconciliationService,
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
