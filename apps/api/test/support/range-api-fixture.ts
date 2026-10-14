import { Test } from '@nestjs/testing';
import { compileTemplateTopology, type ScenarioGraphDraft } from '@aliyun-cyber-range/scenario-runtime';

import { ADMIN_REPOSITORY, type AdminRepository, type PlatformImageAssetRecord } from '../../src/admin/admin.repository';
import { SystemConfigService } from '../../src/admin/system-config.service';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap/configure-app';
import { DryRunRangeProvisioner } from '../../src/provisioning/dry-run-range-provisioner';
import { ProvisioningWorkerService } from '../../src/provisioning/provisioning-worker.service';
import { RANGE_PROVISIONER, type RangeProvisioner } from '../../src/provisioning/provisioning.types';
import { createMemoryAdminRepository } from './create-memory-admin-repository';
import { loginAsRepositoryUser, overrideTestOidc } from './test-oidc';
import { OperationControlService } from '../../src/operations/operation-control.service';
import { runInCloudWorkspace } from '../../src/auth/cloud-workspace-scope';

export async function createRangeApiFixture(provisioner: RangeProvisioner = new DryRunRangeProvisioner()) {
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_USERNAME = 'admin';
  const repository = createMemoryAdminRepository();
  const config = {
    provider: 'alibaba_cloud' as const,
    defaultRegion: 'cn-hangzhou',
    defaultZoneId: 'cn-hangzhou-h',
    accessKeyId: '',
    accessKeySecret: '',
    imageImportBucket: '',
  };
  const moduleRef = await overrideTestOidc(Test.createTestingModule({ imports: [AppModule] }))
    .overrideProvider(ADMIN_REPOSITORY).useValue(repository)
    .overrideProvider(RANGE_PROVISIONER).useValue(provisioner)
    .overrideProvider(SystemConfigService).useValue({
      getSnapshot: async () => config,
      getAccountContext: async () => ({ ...config, accountUid: null, accountUidResolved: false }),
    })
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const operations = app.get(OperationControlService);
  const executeRecovery = operations.executeRangeRecoveryIntake.bind(operations);
  jest.spyOn(operations, 'executeRangeRecoveryIntake').mockImplementation(input =>
    runInCloudWorkspace({ cloudWorkspaceId: 'legacy-unbound', provider: 'alibaba_cloud', accountUid: null }, () => executeRecovery(input)));
  return {
    app,
    repository,
    adminToken: await loginAsRepositoryUser(repository, 'admin'),
    worker: app.get(ProvisioningWorkerService),
  };
}

export async function collectRangeFixtureImage(repository: AdminRepository) {
  const imageId = 'm-range-api-fixture';
  await repository.upsertImageSnapshots({
    provider: 'alibaba_cloud', accountUid: null, regionId: 'cn-hangzhou', scope: 'custom',
    snapshots: [{
      imageId, sourceImageName: 'Range API fixture image', status: 'Available',
      isAvailable: true, lastSyncedAt: new Date(),
    }],
  });
  const [snapshot] = await repository.listImageSnapshots({ imageId });
  return repository.collectPlatformImageAsset({
    snapshotId: snapshot!.id, displayName: 'Range API fixture image',
    ownerUserId: 'admin', visibility: 'platform',
  });
}

export function rangeTemplatePayload(image: PlatformImageAssetRecord, name: string, vpcCidr = '10.70.0.0/16') {
  const prefix = vpcCidr.split('.').slice(0, 2).join('.');
  const privateIp = `${prefix}.10.10`;
  const graph: ScenarioGraphDraft = {
    schemaVersion: '2.0.0',
    nodes: [
      { id: 'router-main', kind: 'router', label: 'VPC', routeRole: 'vpc', egressType: 'none', bindEip: false },
      {
        id: 'switch-dmz', kind: 'switch', label: 'DMZ', zoneKey: 'dmz',
        cidr: `${prefix}.10.0/24`, purpose: 'public-entry', aclRules: [],
        nat: { snatEnabled: false, dnatMappings: [{
          key: 'entry-ssh', targetHostId: 'dmz-entry', externalPort: 22, internalPort: 22, protocol: 'tcp',
        }] },
      },
      {
        id: 'dmz-entry', kind: 'ecs', label: 'Entry', zoneKey: 'dmz', role: 'entry',
        privateIp, exposePublic: true, image: image.displayName, imageId: image.imageId,
        platformImageAssetId: image.id, imageStrategy: { mode: 'fixed', imageId: image.imageId },
        instanceTypeStrategy: { mode: 'auto' }, dnatMappings: [], networkInterfaces: [],
        portGroups: [], initScript: '', nics: [{
          id: 'nic-entry', switchId: 'switch-dmz', privateIp, secondaryIps: [], securityGroupRules: [],
        }],
      },
    ],
    edges: [
      { id: 'router-switch', fromNodeId: 'router-main', toNodeId: 'switch-dmz', relationType: 'manual' },
      { id: 'switch-entry', fromNodeId: 'switch-dmz', toNodeId: 'dmz-entry', relationType: 'manual' },
    ],
  };
  return { name, ...compileTemplateTopology(graph, {
    name, slug: 'fixture', version: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu',
    modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
    primaryVpcCidr: vpcCidr, secondaryVpcCidrs: [],
  }) };
}

export function futureExpiration() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}
