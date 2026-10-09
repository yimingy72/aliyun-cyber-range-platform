import { fixturePlan, fixtureState, persistSuccessfulApply } from './opentofu-state-fixture';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  OpenTofuRangeProvisioner,
  createRangeProvisionerFromEnv,
} from '../src/provisioning/open-tofu-range-provisioner';
import { DryRunRangeProvisioner } from '../src/provisioning/dry-run-range-provisioner';
import { resolvePreferredInstanceTypes } from '../src/provisioning/instance-type-catalog';
import type { RangeProvisionStepEvent } from '../src/provisioning/provisioning.types';

const testRuntimeCredentials = new Proxy<Record<string, { username: string; password: string }>>(
  {},
  {
    get: () => ({ username: 'root', password: 'RuntimePassword123!' }),
  },
);

describe('OpenTofuRangeProvisioner', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses explicit runtime config when environment cloud settings are absent', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-runtime-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');

    await fs.mkdir(moduleDir, { recursive: true });

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'dmz',
            public_ip: '1.1.1.1',
            private_ip: '10.90.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-runtime',
            subnet_ids: { dmz: 'vsw-dmz' },
            host_ids: { 'dmz-entry': 'i-dmz' },
            resolved_instance_type: 'ecs.c7.large',
            resolved_image_id: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      env: {
        OPENTOFU_INSTANCE_TYPE: 'ecs.c7.large',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-runtime',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      runtimeConfig: {
        accessKeyId: 'db-ak',
        accessKeySecret: 'db-sk',
        defaultRegion: 'cn-hangzhou',
        defaultZoneId: 'cn-hangzhou-h',
      },
      topologySpec: {
        vpcCidr: '10.90.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.90.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.90.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'dmz-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const workspaceDir = path.join(workspacesRootDir, 'range-instance-runtime');
    const varsFilePath = path.join(workspaceDir, 'range.auto.tfvars.json');

    expect(JSON.parse(await fs.readFile(varsFilePath, 'utf8'))).toEqual(
      expect.objectContaining({
        zone_id: 'cn-hangzhou-h',
      }),
    );
    expect(runner.init).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          ALICLOUD_ACCESS_KEY: 'db-ak',
          ALICLOUD_SECRET_KEY: 'db-sk',
          ALICLOUD_REGION: 'cn-hangzhou',
        }),
        workspaceDir,
      }),
    );
  });

  it('uses persisted runtime passwords when no default instance password is configured', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-runtime-password-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');

    await fs.mkdir(moduleDir, { recursive: true });

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: { value: { host_role: 'dmz', public_ip: null, private_ip: '10.90.10.10', ssh: null } },
        resource_summary: { value: { vpc_id: 'vpc-runtime-password' } },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      env: {
        OPENTOFU_INSTANCE_TYPE: 'ecs.c7.large',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-runtime-password',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeConfig: {
        accessKeyId: 'db-ak',
        accessKeySecret: 'db-sk',
        defaultRegion: 'cn-hangzhou',
        defaultZoneId: 'cn-hangzhou-h',
      },
      runtimeCredentials: {
        'dmz-entry': { username: 'root', password: 'RuntimePassword123!' },
      },
      topologySpec: {
        vpcCidr: '10.90.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.90.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.90.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'dmz-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const varsFilePath = path.join(
      workspacesRootDir,
      'range-instance-runtime-password',
      'range.auto.tfvars.json',
    );

    expect(JSON.parse(await fs.readFile(varsFilePath, 'utf8'))).toEqual(
      expect.objectContaining({
        host_passwords: { 'dmz-entry': 'RuntimePassword123!' },
        instance_password: 'RuntimePassword123!',
      }),
    );
  });

  it('does not call the aliyun image resolver when a fixed image id is configured', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-fixed-image-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');

    await fs.mkdir(moduleDir, { recursive: true });

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: { value: { host_role: 'dmz', public_ip: null, private_ip: '10.91.10.10', ssh: null } },
        resource_summary: { value: { vpc_id: 'vpc-fixed-image' } },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };
    const imageResolver = jest.fn().mockResolvedValue('should-not-be-used');

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      availableImageIdResolver: imageResolver,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        OPENTOFU_INSTANCE_TYPE: 'ecs.u1-c1m2.large',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-fixed-image',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      topologySpec: {
        vpcCidr: '10.91.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.91.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.91.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'dmz-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    expect(imageResolver).not.toHaveBeenCalled();
  });

  it('preserves the existing workspace state during update-style apply runs', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-update-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const workspaceDir = path.join(workspacesRootDir, 'range-instance-update');
    const sentinelPath = path.join(workspaceDir, 'terraform.tfstate');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(sentinelPath, JSON.stringify(fixtureState), 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue({ ...fixturePlan, resource_changes: [] }),
      output: jest.fn().mockResolvedValue({
        public_entry: { value: { host_role: 'dmz', public_ip: null, private_ip: '10.92.10.10', ssh: null } },
        resource_summary: { value: { vpc_id: 'vpc-update' } },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        OPENTOFU_INSTANCE_TYPE: 'ecs.e-c1m1.large',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-update',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      preserveWorkspaceState: true,
      topologySpec: {
        vpcCidr: '10.92.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.92.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.92.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'dmz-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    await expect(fs.readFile(sentinelPath, 'utf8')).resolves.toBe(JSON.stringify(fixtureState));
  });

  it('renders the single ECS module with existing network ids when instanceMode is single', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-single-'));
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const availableInstanceTypeResolver = jest.fn().mockResolvedValue('ecs.u1-c1m1.large');

    const provisioner = new OpenTofuRangeProvisioner({
      projectRootDir: tempRootDir,
      workspacesRootDir,
      availableInstanceTypeResolver,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        OPENTOFU_INSTANCE_TYPE: 'auto',
      },
    });

    const result = await provisioner.renderSingleInstanceWorkspace({
      rangeInstanceId: 'single-1',
      runtimeCredentials: {
        'single-ecs-1': { username: 'root', password: 'Aa123456!' },
      },
      singleInstanceConfig: {
        baseName: 'web-lab',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'web-lab-01',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04 LTS',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        remark: 'single instance',
        assignedVswitchId: 'vsw-1',
      },
      singleNetworkProfile: {
        id: 'single-network-1',
        provider: 'alibaba_cloud',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        vpcId: 'vpc-1',
        vpcCidr: '10.200.0.0/16',
        vswitchIds: ['vsw-1', 'vsw-2', 'vsw-3'],
        vswitchCidrs: ['10.200.1.0/24', '10.200.2.0/24', '10.200.3.0/24'],
        securityGroupId: 'sg-1',
        securityGroupName: 'default-open-all',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    expect(result.files['main.tf']).toContain(
      'source = "infra/opentofu/modules/alicloud-vpc-single-ecs"',
    );
    expect(result.files['terraform.tfvars.json']).toContain('"existing_vpc_id":"vpc-1"');
    expect(result.files['terraform.tfvars.json']).toContain('"existing_vswitch_id":"vsw-1"');
    expect(result.files['terraform.tfvars.json']).toContain('"existing_security_group_id":"sg-1"');
    expect(availableInstanceTypeResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m1.large'],
      }),
    );
    expect(result.files['terraform.tfvars.json']).toContain('"instance_type":"ecs.u1-c1m1.large"');
  });

  it('prefers an explicit fixed instance type policy over stale cpu-memory derived candidates', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-fixed-policy-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');

    await fs.mkdir(moduleDir, { recursive: true });

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: { value: { host_role: 'dmz', public_ip: null, private_ip: '10.93.10.10', ssh: null } },
        resource_summary: { value: { vpc_id: 'vpc-fixed-policy' } },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      enableZoneScheduling: false,
      availableImageIdResolver: jest.fn().mockResolvedValue('ubuntu_24_04_x64_20G_alibase_20260615.vhd'),
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-fixed-policy',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      topologySpec: {
        vpcCidr: '10.93.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.93.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.93.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledProvisionSpec: {
        topology: {
          vpcCidr: '10.93.0.0/16',
          entryHostKey: 'ecs-1',
        },
        networkZones: [{ key: 'dmz', name: 'DMZ', cidr: '10.93.10.0/24', purpose: 'public-entry', isPublicEntry: true }],
        hosts: [{ key: 'ecs-1', name: 'ECS 1', zoneKey: 'dmz', role: 'entry', primaryPrivateIp: '10.93.10.10', exposePublic: true, instanceTypePolicyKey: 'ecs-1-instance-type-policy' }],
        runtimeSelections: {
          instanceTypePolicies: {
            'ecs-1-instance-type-policy': {
              key: 'ecs-1-instance-type-policy',
              mode: 'fixed',
              instanceType: 'ecs.e-c1m2.large',
            },
          },
        },
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        resources: [
          {
            id: 'ecs-1',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              cpu: 2,
              memory: 2,
              instanceType: 'ecs.e-c1m1.large',
            },
          },
        ],
      },
    });

    const varsFilePath = path.join(workspacesRootDir, 'range-instance-fixed-policy', 'range.auto.tfvars.json');
    const varsPayload = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

    expect(varsPayload.hosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'ecs-1',
          instance_type: 'ecs.e-c1m2.large',
        }),
      ]),
    );
  });

  it('prepares a dedicated workspace, writes variables, and runs the OpenTofu lifecycle', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'dmz',
            public_ip: '1.1.1.1',
            private_ip: '10.88.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-local',
            subnet_ids: {
              dmz: 'vsw-dmz',
              office: 'vsw-office',
              server: 'vsw-server',
            },
            host_ids: {
              'dmz-entry': 'i-dmz',
              'office-client': 'i-office',
              'server-app': 'i-server',
            },
            nat_gateway_ids: {
              'nat-office': 'ngw-office',
            },
            eip_allocation_id: 'eip-local',
            eip_allocation_ids: {
              'eip-entry': 'eip-local',
              'eip-office-nat': 'eip-office',
            },
            snat_entry_ids: {
              'snat-office': 'snat-001',
            },
            dnat_entry_ids: {
              'dnat-entry-web': 'dnat-001',
            },
            resolved_instance_type: 'ecs.u1-c1m2.large',
            resolved_image_id: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
            resolved_image_ids: {
              'dmz-entry': 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
              'office-client': 'm-office-image',
              'server-app': 'm-server-image',
            },
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
        OPENTOFU_INSTANCE_TYPE: 'ecs.c7.large',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        OPENTOFU_ALLOWED_INGRESS_CIDR: '10.0.0.0/8',
      },
    });
    const stepEvents: RangeProvisionStepEvent[] = [];

    const result = await provisioner.create({
      rangeInstanceId: 'range-instance-1',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      reportStep: async (event) => {
        stepEvents.push(event);
      },
      topologySpec: {
        vpcCidr: '10.88.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.88.10.0/24',
            isPublicEntry: true,
          },
          {
            key: 'office',
            name: 'Office',
            purpose: 'user-workstations',
            cidr: '10.88.20.0/24',
          },
          {
            key: 'server',
            name: 'Server',
            purpose: 'application-servers',
            cidr: '10.88.30.0/24',
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.88.10.10',
            exposePublic: true,
          },
          {
            key: 'office-client',
            name: 'Office Client',
            zoneKey: 'office',
            role: 'workstation',
            privateIp: '10.88.20.10',
          },
          {
            key: 'server-app',
            name: 'Server App',
            zoneKey: 'server',
            role: 'app',
            privateIp: '10.88.30.10',
          },
        ],
        publicEntry: {
          hostKey: 'dmz-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.88.0.0/16',
          publicEntryHostKey: 'dmz-entry',
          networkZoneKeys: ['dmz', 'office', 'server'],
          hostKeys: ['dmz-entry', 'office-client', 'server-app'],
        },
        resources: [
          {
            id: 'switch-dmz',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: { label: 'DMZ', zoneKey: 'dmz', cidr: '10.88.10.0/24', purpose: 'public-entry' },
          },
          {
            id: 'switch-office',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: 'Office',
              zoneKey: 'office',
              cidr: '10.88.20.0/24',
              purpose: 'user-workstations',
            },
          },
          {
            id: 'switch-server',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: 'Server',
              zoneKey: 'server',
              cidr: '10.88.30.0/24',
              purpose: 'application-servers',
            },
          },
          {
            id: 'dmz-entry',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: 'DMZ Entry',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.88.10.10',
              exposePublic: true,
            },
          },
          {
            id: 'office-client',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: 'Office Client',
              zoneKey: 'office',
              role: 'workstation',
              privateIp: '10.88.20.10',
            },
          },
          {
            id: 'server-app',
            type: 'host',
            provider: 'alibaba_cloud',
            config: { label: 'Server App', zoneKey: 'server', role: 'app', privateIp: '10.88.30.10' },
          },
          {
            id: 'nat-office',
            type: 'nat_gateway',
            provider: 'alibaba_cloud',
            config: { label: 'Office NAT', zoneKey: 'office', snatEnabled: true },
          },
          {
            id: 'eip-entry',
            type: 'eip',
            provider: 'alibaba_cloud',
            config: {
              label: 'Entry EIP',
              bindTargetType: 'host',
              bindTargetKey: 'dmz-entry',
              bandwidthMbps: 30,
            },
          },
          {
            id: 'eip-office-nat',
            type: 'eip',
            provider: 'alibaba_cloud',
            config: {
              label: 'Office NAT EIP',
              bindTargetType: 'nat_gateway',
              bindTargetKey: 'nat-office',
              bandwidthMbps: 50,
            },
          },
          {
            id: 'sg-entry-ssh',
            type: 'security_group_rule',
            provider: 'alibaba_cloud',
            config: {
              label: 'Entry SSH Allow',
              targetHostKey: 'dmz-entry',
              direction: 'ingress',
              policy: 'accept',
              protocol: 'tcp',
              portRange: '22/22',
              sourceCidr: '0.0.0.0/0',
              priority: 1,
            },
          },
          {
            id: 'acl-office-inbound',
            type: 'acl',
            provider: 'alibaba_cloud',
            config: {
              label: 'Office ACL',
              zoneKey: 'office',
              direction: 'inbound',
              policy: 'accept',
              protocol: 'tcp',
              portRange: '3389/3389',
              sourceCidr: '10.0.0.0/8',
              priority: 10,
            },
          },
        ],
      },
    });

    const workspaceDir = path.join(workspacesRootDir, 'range-instance-1');
    const varsFilePath = path.join(workspaceDir, 'range.auto.tfvars.json');
    const cliConfigFilePath = path.join(workspacesRootDir, 'provider-mirror', 'tofu.tfrc');
    const workspaceFiles = await fs.readdir(workspaceDir);
    const mainTf = await fs.readFile(path.join(workspaceDir, 'main.tf'), 'utf8');

    expect(workspaceFiles).toEqual(
      expect.arrayContaining([
        'main.tf',
        'variables.tf',
        'outputs.tf',
        'versions.tf',
        'range.auto.tfvars.json',
      ]),
    );
    expect(mainTf).toContain('module "range"');
    expect(mainTf).toContain(`source = "${moduleDir}"`);
    expect(JSON.parse(await fs.readFile(varsFilePath, 'utf8'))).toEqual(
      expect.objectContaining({
        resource_name_prefix: 'range-range-ins',
        zone_id: 'cn-hangzhou-h',
        vpc_cidr: '10.88.0.0/16',
        entry_host_key: 'dmz-entry',
        network_zones: [
          {
            key: 'dmz',
            name: 'DMZ',
            cidr: '10.88.10.0/24',
            purpose: 'public-entry',
            is_public_entry: true,
          },
          {
            key: 'office',
            name: 'Office',
            cidr: '10.88.20.0/24',
            purpose: 'user-workstations',
            is_public_entry: false,
          },
          {
            key: 'server',
            name: 'Server',
            cidr: '10.88.30.0/24',
            purpose: 'application-servers',
            is_public_entry: false,
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zone_key: 'dmz',
            private_ip: '10.88.10.10',
            role: 'entry',
            expose_public: true,
            instance_type: 'ecs.c7.large',
          },
          {
            key: 'office-client',
            name: 'Office Client',
            zone_key: 'office',
            private_ip: '10.88.20.10',
            role: 'workstation',
            expose_public: false,
            instance_type: 'ecs.c7.large',
          },
          {
            key: 'server-app',
            name: 'Server App',
            zone_key: 'server',
            private_ip: '10.88.30.10',
            role: 'app',
            expose_public: false,
            instance_type: 'ecs.c7.large',
          },
        ],
        nat_gateways: [
          {
            key: 'nat-office',
            name: 'Office NAT',
            zone_key: 'office',
            snat_enabled: true,
          },
        ],
        eips: [
          {
            key: 'eip-entry',
            name: 'Entry EIP',
            bind_target_type: 'host',
            bind_target_key: 'dmz-entry',
            bandwidth_mbps: 30,
          },
          {
            key: 'eip-office-nat',
            name: 'Office NAT EIP',
            bind_target_type: 'nat_gateway',
            bind_target_key: 'nat-office',
            bandwidth_mbps: 50,
          },
        ],
        security_group_rules: [
          {
            key: 'sg-entry-ssh',
            name: 'Entry SSH Allow',
            target_host_key: 'dmz-entry',
            direction: 'ingress',
            policy: 'accept',
            protocol: 'tcp',
            port_range: '22/22',
            source_cidr: '0.0.0.0/0',
            priority: 1,
          },
        ],
        acls: [
          {
            key: 'acl-office-inbound',
            name: 'Office ACL',
            zone_key: 'office',
            direction: 'inbound',
            policy: 'accept',
            protocol: 'tcp',
            port_range: '3389/3389',
            source_cidr: '10.0.0.0/8',
            priority: 10,
          },
        ],
        dmz_cidr: '10.88.10.0/24',
        office_cidr: '10.88.20.0/24',
        server_cidr: '10.88.30.0/24',
        dmz_private_ip: '10.88.10.10',
        office_private_ip: '10.88.20.10',
        server_private_ip: '10.88.30.10',
        instance_type: 'ecs.c7.large',
        image_id: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        instance_password: 'RuntimePassword123!',
        allowed_ingress_cidr: '10.0.0.0/8',
      }),
    );
    expect(await fs.readFile(cliConfigFilePath, 'utf8')).toContain('registry.opentofu.org/aliyun/alicloud');

    expect(runner.init).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir,
        env: expect.objectContaining({
          ALICLOUD_ACCESS_KEY: 'test-ak',
          ALICLOUD_SECRET_KEY: 'test-sk',
          ALICLOUD_REGION: 'cn-hangzhou',
          TF_CLI_CONFIG_FILE: cliConfigFilePath,
        }),
      }),
    );
    expect(runner.validate).not.toHaveBeenCalled();
    expect(runner.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir,
        planFilePath: path.join(workspaceDir, 'range.tfplan'),
        varsFilePath,
      }),
    );
    expect(runner.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir,
        planFilePath: path.join(workspaceDir, 'range.tfplan'),
      }),
    );
    expect(runner.output).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir,
      }),
    );
    expect(stepEvents).toEqual([
      expect.objectContaining({ stepName: 'render_template', status: 'running' }),
      expect.objectContaining({ stepName: 'render_template', status: 'succeeded' }),
      expect.objectContaining({ stepName: 'tofu_init', status: 'running' }),
      expect.objectContaining({ stepName: 'tofu_init', status: 'succeeded' }),
      expect.objectContaining({ stepName: 'tofu_plan', status: 'running' }),
      expect.objectContaining({ stepName: 'tofu_plan', status: 'succeeded' }),
      expect.objectContaining({ stepName: 'tofu_apply', status: 'running' }),
      expect.objectContaining({ stepName: 'tofu_apply', status: 'succeeded' }),
      expect.objectContaining({ stepName: 'collect_outputs', status: 'running' }),
      expect.objectContaining({ stepName: 'collect_outputs', status: 'succeeded' }),
    ]);

    expect(result).toEqual({
      accessEntry: {
        hostRole: 'dmz',
        publicIp: '1.1.1.1',
        privateIp: '10.88.10.10',
        ssh: 'ssh root@example.range',
      },
      resourceSummary: {
        bootstrapHostKeys: null,
        eipAllocationId: 'eip-local',
        eipAllocationIds: {
          'eip-entry': 'eip-local',
          'eip-office-nat': 'eip-office',
        },
        dnatEntryIds: {
          'dnat-entry-web': 'dnat-001',
        },
        hostIds: {
          'dmz-entry': 'i-dmz',
          'office-client': 'i-office',
          'server-app': 'i-server',
        },
        mode: 'opentofu',
        networkAclIds: null,
        natGatewayIds: {
          'nat-office': 'ngw-office',
        },
        outputFilePath: path.join(workspaceDir, 'outputs.json'),
        resolvedImageId: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        resolvedImageIds: {
          'dmz-entry': 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
          'office-client': 'm-office-image',
          'server-app': 'm-server-image',
        },
        resolvedInstanceType: 'ecs.u1-c1m2.large',
        runtimeSelections: null,
        selectedZoneId: null,
        attemptedZones: null,
        secondaryNetworkInterfaceIds: null,
        securityGroupIds: null,
        snatEntryIds: {
          'snat-office': 'snat-001',
        },
        subnetIds: {
          dmz: 'vsw-dmz',
          office: 'vsw-office',
          server: 'vsw-server',
        },
        topologySpec: {
          hostKeys: ['dmz-entry', 'office-client', 'server-app'],
          networkZoneKeys: ['dmz', 'office', 'server'],
          publicEntryHostKey: 'dmz-entry',
          vpcCidr: '10.88.0.0/16',
        },
        vpcId: 'vpc-local',
        workspaceDir,
      },
    });
  });

  it('reports failed OpenTofu command steps with stderr excerpts', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-failure-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockRejectedValue(
        Object.assign(new Error('plan failed'), {
          stdout: 'stdout-plan',
          stderr: 'stderr-plan',
        }),
      ),
      apply: jest.fn(),
      showPlan: jest.fn(),
      output: jest.fn(),
      destroy: jest.fn(),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        OPENTOFU_INSTANCE_TYPE: 'ecs.c7.large',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
      },
    });
    const stepEvents: RangeProvisionStepEvent[] = [];

    await expect(
      provisioner.create({
        rangeInstanceId: 'range-instance-3',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
        reportStep: async (event) => {
          stepEvents.push(event);
        },
        topologySpec: {
          vpcCidr: '10.90.0.0/16',
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              purpose: 'public-entry',
              cidr: '10.90.10.0/24',
              isPublicEntry: true,
            },
            {
              key: 'office',
              name: 'Office',
              purpose: 'user-workstations',
              cidr: '10.90.20.0/24',
            },
            {
              key: 'server',
              name: 'Server',
              purpose: 'application-servers',
              cidr: '10.90.30.0/24',
            },
          ],
          hosts: [
            {
              key: 'dmz-entry',
              name: 'DMZ Entry',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.90.10.10',
              exposePublic: true,
            },
            {
              key: 'office-client',
              name: 'Office Client',
              zoneKey: 'office',
              role: 'workstation',
              privateIp: '10.90.20.10',
            },
            {
              key: 'server-app',
              name: 'Server App',
              zoneKey: 'server',
              role: 'app',
              privateIp: '10.90.30.10',
            },
          ],
          publicEntry: {
            hostKey: 'dmz-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      }),
    ).rejects.toThrow('plan failed');

    expect(stepEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepName: 'tofu_plan', status: 'running' }),
        expect.objectContaining({
          stepName: 'tofu_plan',
          status: 'failed',
          stderrExcerpt: 'stderr-plan',
        }),
      ]),
    );
  });

  it('resolves auto instance types before rendering variables when env requests automatic selection', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-auto-instance-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const availableInstanceTypeResolver = jest.fn().mockResolvedValue('ecs.u1-c1m2.large');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'dmz',
            public_ip: '1.1.1.1',
            private_ip: '10.91.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-auto',
            subnet_ids: {
              dmz: 'vsw-dmz',
              office: 'vsw-office',
              server: 'vsw-server',
            },
            host_ids: {
              'dmz-entry': 'i-dmz',
              'office-client': 'i-office',
              'server-app': 'i-server',
            },
            eip_allocation_id: 'eip-auto',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      enableZoneScheduling: false,
      availableInstanceTypeResolver,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
        OPENTOFU_INSTANCE_TYPE: 'auto',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        OPENTOFU_SYSTEM_DISK_CATEGORY: 'cloud_essd',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-auto',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      reportStep: async () => undefined,
      topologySpec: {
        vpcCidr: '10.91.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.91.10.0/24',
            isPublicEntry: true,
          },
          {
            key: 'office',
            name: 'Office',
            purpose: 'user-workstations',
            cidr: '10.91.20.0/24',
          },
          {
            key: 'server',
            name: 'Server',
            purpose: 'application-servers',
            cidr: '10.91.30.0/24',
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.91.10.10',
            exposePublic: true,
          },
          {
            key: 'office-client',
            name: 'Office Client',
            zoneKey: 'office',
            role: 'workstation',
            privateIp: '10.91.20.10',
          },
          {
            key: 'server-app',
            name: 'Server App',
            zoneKey: 'server',
            role: 'app',
            privateIp: '10.91.30.10',
          },
        ],
        publicEntry: {
          hostKey: 'dmz-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const varsFilePath = path.join(workspacesRootDir, 'range-instance-auto', 'range.auto.tfvars.json');
    const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

    expect(availableInstanceTypeResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKey: 'test-ak',
        secretKey: 'test-sk',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        systemDiskCategory: 'cloud_essd',
        preferredInstanceTypes: expect.arrayContaining(['ecs.u1-c1m2.large']),
      }),
    );
    expect(renderedVariables.instance_type).toBe('ecs.u1-c1m2.large');
  });

  it('resolves catalog-backed host sizes through their economy-first fallback candidates', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-host-instance-type-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const availableInstanceTypeResolver = jest.fn().mockResolvedValue('ecs.u1-c1m2.large');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.95.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-host-instance',
            subnet_ids: { zone1: 'vsw-zone1' },
            host_ids: { 'ecs-1': 'i-ecs1' },
            eip_allocation_id: 'eip-host-instance',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      enableZoneScheduling: false,
      availableInstanceTypeResolver,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
        OPENTOFU_INSTANCE_TYPE: 'auto',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        OPENTOFU_SYSTEM_DISK_CATEGORY: 'cloud_essd',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-host-instance-type',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      reportStep: async () => undefined,
      topologySpec: {
        vpcCidr: '10.95.0.0/16',
        networkZones: [
          {
            key: 'zone-1',
            name: 'Zone 1',
            purpose: 'public-entry',
            cidr: '10.95.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'zone-1',
            role: 'entry',
            privateIp: '10.95.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledProvisionSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.95.0.0/16',
          entryHostKey: 'ecs-1',
        },
        networkZones: [
          {
            key: 'zone-1',
            name: 'Zone 1',
            cidr: '10.95.10.0/24',
            purpose: 'public-entry',
            isPublicEntry: true,
            routeRole: 'entry',
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            role: 'entry',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.95.10.10',
            exposePublic: true,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'zone-1', privateIp: '10.95.10.10' }],
            instanceTypePolicyKey: 'ecs-1-instance-type-policy',
          },
        ],
        natGateways: [],
        eips: [{ key: 'entry-default', name: 'Entry EIP', bindTargetType: 'host', bindTargetKey: 'ecs-1', bandwidthMbps: 10 }],
        snatEntries: [],
        dnatEntries: [],
        securityGroupRules: [],
        aclRules: [],
        bootstrapScripts: [],
        runtimeSelections: {
          imagePolicies: {},
          instanceTypePolicies: {
            'ecs-1-instance-type-policy': {
              key: 'ecs-1-instance-type-policy',
              mode: 'auto',
              preferredInstanceTypes: [],
            },
          },
        },
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.95.0.0/16',
          publicEntryHostKey: 'ecs-1',
          networkZoneKeys: ['zone-1'],
          hostKeys: ['ecs-1'],
        },
        resources: [
          {
            id: 'ecs-1',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: 'ECS 1',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.95.10.10',
              exposePublic: true,
              cpu: 2,
              memory: 2,
              instanceTypeStrategy: {
                mode: 'auto',
                preferredInstanceTypes: [],
              },
            },
          },
          {
            id: 'switch-1',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: 'Zone 1',
              zoneKey: 'zone-1',
              cidr: '10.95.10.0/24',
              purpose: 'public-entry',
            },
          },
        ],
      },
    });

    const varsFilePath = path.join(workspacesRootDir, 'range-instance-host-instance-type', 'range.auto.tfvars.json');
    const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

    expect(availableInstanceTypeResolver).toHaveBeenCalledTimes(1);
    expect(availableInstanceTypeResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKey: 'test-ak',
        secretKey: 'test-sk',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        systemDiskCategory: 'cloud_essd',
        preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m1.large'],
      }),
    );
    expect(renderedVariables.hosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'ecs-1',
          instance_type: 'ecs.u1-c1m2.large',
        }),
      ]),
    );
  });

  it('returns economy-first preferred instance type candidates for catalog-backed host sizes', () => {
    const smallCandidates = resolvePreferredInstanceTypes(2, 2);

    expect(smallCandidates).toEqual([
      'ecs.e-c1m1.large',
      'ecs.u1-c1m1.large',
      'ecs.t6-c1m1.large',
    ]);
    expect(Object.isFrozen(smallCandidates)).toBe(true);
    expect(resolvePreferredInstanceTypes(4, 8)).toEqual([
      'ecs.e-c1m2.xlarge',
      'ecs.u1-c1m2.xlarge',
    ]);
    expect(resolvePreferredInstanceTypes(8, 16)).toEqual([
      'ecs.e-c1m2.2xlarge',
      'ecs.u1-c1m2.2xlarge',
    ]);
  });

  it('prefers an explicit fixed instance type over stale cpu-memory derived candidates', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-stale-host-instance-type-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const availableInstanceTypeResolver = jest.fn().mockResolvedValue('should-not-be-used');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.95.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-host-instance-stale',
            subnet_ids: { 'zone-1': 'vsw-zone1' },
            host_ids: { 'ecs-1': 'i-ecs1' },
            eip_allocation_id: 'eip-host-instance-stale',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      enableZoneScheduling: false,
      availableInstanceTypeResolver,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
        OPENTOFU_INSTANCE_TYPE: 'auto',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        OPENTOFU_SYSTEM_DISK_CATEGORY: 'cloud_essd',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-stale-host-instance-type',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      reportStep: async () => undefined,
      topologySpec: {
        vpcCidr: '10.95.0.0/16',
        networkZones: [
          {
            key: 'zone-1',
            name: 'Zone 1',
            purpose: 'public-entry',
            cidr: '10.95.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'zone-1',
            role: 'entry',
            privateIp: '10.95.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledProvisionSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.95.0.0/16',
          entryHostKey: 'ecs-1',
        },
        networkZones: [
          {
            key: 'zone-1',
            name: 'Zone 1',
            cidr: '10.95.10.0/24',
            purpose: 'public-entry',
            isPublicEntry: true,
            routeRole: 'entry',
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            role: 'entry',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.95.10.10',
            exposePublic: true,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'zone-1', privateIp: '10.95.10.10' }],
            instanceTypePolicyKey: 'ecs-1-instance-type-policy',
          },
        ],
        natGateways: [],
        eips: [{ key: 'entry-default', name: 'Entry EIP', bindTargetType: 'host', bindTargetKey: 'ecs-1', bandwidthMbps: 10 }],
        snatEntries: [],
        dnatEntries: [],
        securityGroupRules: [],
        aclRules: [],
        bootstrapScripts: [],
        runtimeSelections: {
          imagePolicies: {},
          instanceTypePolicies: {
            'ecs-1-instance-type-policy': {
              key: 'ecs-1-instance-type-policy',
              mode: 'fixed',
              instanceType: 'ecs.u1-c1m2.large',
            },
          },
        },
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.95.0.0/16',
          publicEntryHostKey: 'ecs-1',
          networkZoneKeys: ['zone-1'],
          hostKeys: ['ecs-1'],
        },
        resources: [
          {
            id: 'ecs-1',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: 'ECS 1',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.95.10.10',
              exposePublic: true,
              cpu: 2,
              memory: 2,
              instanceType: 'ecs.u1-c1m2.large',
              instanceTypeStrategy: {
                mode: 'fixed',
                instanceType: 'ecs.u1-c1m2.large',
              },
            },
          },
          {
            id: 'switch-1',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: 'Zone 1',
              zoneKey: 'zone-1',
              cidr: '10.95.10.0/24',
              purpose: 'public-entry',
            },
          },
        ],
      },
    });

    const varsFilePath = path.join(workspacesRootDir, 'range-instance-stale-host-instance-type', 'range.auto.tfvars.json');
    const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

    expect(availableInstanceTypeResolver).not.toHaveBeenCalled();
    expect(renderedVariables.hosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'ecs-1',
          instance_type: 'ecs.u1-c1m2.large',
        }),
      ]),
    );
  });

  it('uses final imageId and instanceType from compiled host data without calling aliyun runtime resolvers', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-host-final-values-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const availableInstanceTypeResolver = jest.fn().mockResolvedValue('should-not-be-used');
    const availableImageIdResolver = jest.fn().mockResolvedValue('should-not-be-used');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.96.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-host-final-values',
            subnet_ids: { 'zone-1': 'vsw-zone1' },
            host_ids: { 'ecs-1': 'i-ecs1', 'ecs-2': 'i-ecs2' },
            eip_allocation_id: 'eip-host-final-values',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      enableZoneScheduling: false,
      availableInstanceTypeResolver,
      availableImageIdResolver,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
        OPENTOFU_INSTANCE_TYPE: 'auto',
        OPENTOFU_IMAGE_ID: 'auto',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-host-final-values',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      reportStep: async () => undefined,
      topologySpec: {
        vpcCidr: '10.96.0.0/16',
        networkZones: [
          {
            key: 'zone-1',
            name: 'Zone 1',
            purpose: 'public-entry',
            cidr: '10.96.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'zone-1',
            role: 'entry',
            privateIp: '10.96.10.10',
            exposePublic: true,
          },
          {
            key: 'ecs-2',
            name: 'ECS 2',
            zoneKey: 'zone-1',
            role: 'app',
            privateIp: '10.96.10.20',
            exposePublic: false,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledProvisionSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.96.0.0/16',
          entryHostKey: 'ecs-1',
        },
        networkZones: [
          {
            key: 'zone-1',
            name: 'Zone 1',
            cidr: '10.96.10.0/24',
            purpose: 'public-entry',
            isPublicEntry: true,
            routeRole: 'entry',
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            role: 'entry',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.96.10.10',
            exposePublic: true,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'zone-1', privateIp: '10.96.10.10' }],
          },
          {
            key: 'ecs-2',
            name: 'ECS 2',
            role: 'app',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.96.10.20',
            exposePublic: false,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'zone-1', privateIp: '10.96.10.20' }],
          },
        ],
        natGateways: [],
        eips: [{ key: 'entry-default', name: 'Entry EIP', bindTargetType: 'host', bindTargetKey: 'ecs-1', bandwidthMbps: 10 }],
        snatEntries: [],
        dnatEntries: [],
        securityGroupRules: [],
        aclRules: [],
        bootstrapScripts: [],
        runtimeSelections: {
          imagePolicies: {},
          instanceTypePolicies: {},
        },
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.96.0.0/16',
          publicEntryHostKey: 'ecs-1',
          networkZoneKeys: ['zone-1'],
          hostKeys: ['ecs-1', 'ecs-2'],
        },
        resources: [
          {
            id: 'ecs-1',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: 'ECS 1',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.96.10.10',
              exposePublic: true,
              instanceType: 'ecs.g7.large',
              imageId: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
            },
          },
          {
            id: 'ecs-2',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: 'ECS 2',
              zoneKey: 'zone-1',
              role: 'app',
              privateIp: '10.96.10.20',
              exposePublic: false,
              instanceType: 'ecs.c7.large',
              imageId: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
            },
          },
          {
            id: 'switch-1',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: 'Zone 1',
              zoneKey: 'zone-1',
              cidr: '10.96.10.0/24',
              purpose: 'public-entry',
            },
          },
        ],
      },
    });

    const varsFilePath = path.join(
      workspacesRootDir,
      'range-instance-host-final-values',
      'range.auto.tfvars.json',
    );
    const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

    expect(availableInstanceTypeResolver).not.toHaveBeenCalled();
    expect(availableImageIdResolver).not.toHaveBeenCalled();
    expect(renderedVariables.instance_type).toBe('ecs.g7.large');
    expect(renderedVariables.image_id).toBe('ubuntu_24_04_x64_20G_alibase_20260615.vhd');
    expect(renderedVariables.hosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'ecs-1',
          instance_type: 'ecs.g7.large',
          image_id: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        }),
        expect.objectContaining({
          key: 'ecs-2',
          instance_type: 'ecs.c7.large',
          image_id: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        }),
      ]),
    );
  });

  it('uses fetch-based Aliyun compatibility resolvers for legacy templates without final execution values', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-legacy-fetch-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          TotalCount: 1,
          InstanceTypes: {
            InstanceType: [{ InstanceTypeId: 'ecs.u1-c1m2.large', CpuArchitecture: 'x86_64' }],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AvailableZones: {
            AvailableZone: [
              {
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [{ Value: 'ecs.u1-c1m2.large', Status: 'Available' }],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          Images: {
            Image: [{ ImageId: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd', Status: 'Available' }],
          },
        }),
      } as Response);

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.96.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-legacy-fetch',
            subnet_ids: { 'zone-1': 'vsw-zone1' },
            host_ids: { 'ecs-1': 'i-ecs1' },
            eip_allocation_id: 'eip-legacy-fetch',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof global.fetch;

    try {
      const provisioner = new OpenTofuRangeProvisioner({
        runner,
        projectRootDir: tempRootDir,
        workspacesRootDir,
        env: {
          ALICLOUD_REGION: 'cn-hangzhou',
          ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
          ALICLOUD_ACCESS_KEY: 'test-ak',
          ALICLOUD_SECRET_KEY: 'test-sk',
          ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
          OPENTOFU_INSTANCE_TYPE: 'auto',
          OPENTOFU_IMAGE_ID: 'auto',
        },
      });

      const result = await provisioner.create({
        rangeInstanceId: 'range-instance-legacy-fetch',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
        reportStep: async () => undefined,
        topologySpec: {
          vpcCidr: '10.96.0.0/16',
          networkZones: [
            {
              key: 'zone-1',
              name: 'Zone 1',
              purpose: 'public-entry',
              cidr: '10.96.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'Entry Host',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.96.10.10',
              exposePublic: true,
            },
          ],
          publicEntry: {
            hostKey: 'ecs-1',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          resources: [
            {
              id: 'ecs-1',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'Entry Host',
                zoneKey: 'zone-1',
                role: 'entry',
                privateIp: '10.96.10.10',
                exposePublic: true,
                image: 'ubuntu_22_04_x64_20G_alibase',
                cpu: 1,
                memory: 2,
                imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
                instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
              },
            },
          ],
        },
      });

      const varsFilePath = path.join(workspacesRootDir, 'range-instance-legacy-fetch', 'range.auto.tfvars.json');
      const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('Action=DescribeInstanceTypes');
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain('Action=DescribeAvailableResource');
      expect(String(fetchMock.mock.calls[2]?.[0])).toContain('Action=DescribeImages');
      expect(renderedVariables.image_id).toBe('ubuntu_22_04_x64_20G_alibase_20260615.vhd');
      expect(renderedVariables.hosts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'ecs-1',
            instance_type: 'ecs.u1-c1m2.large',
          }),
        ]),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('resolves legacy singleton instance types and image ids when zone scheduling is disabled', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-legacy-singleton-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AvailableZones: {
            AvailableZone: {
              AvailableResources: {
                AvailableResource: {
                  Type: 'InstanceType',
                  SupportedResources: {
                    SupportedResource: {
                      Value: 'ecs.u1-c1m2.large',
                      Status: 'Available',
                    },
                  },
                },
              },
            },
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          Images: {
            Image: {
              ImageId: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
              Status: 'Available',
            },
          },
        }),
      } as Response);

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.96.20.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-legacy-singleton',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof global.fetch;

    try {
      const provisioner = new OpenTofuRangeProvisioner({
        runner,
        projectRootDir: tempRootDir,
        workspacesRootDir,
        enableZoneScheduling: false,
        env: {
          ALICLOUD_REGION: 'cn-hangzhou',
          ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
          ALICLOUD_ACCESS_KEY: 'test-ak',
          ALICLOUD_SECRET_KEY: 'test-sk',
          ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
          OPENTOFU_INSTANCE_TYPE: 'auto',
          OPENTOFU_IMAGE_ID: 'auto',
        },
      });

      const result = await provisioner.create({
        rangeInstanceId: 'range-instance-legacy-singleton',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
        reportStep: async () => undefined,
        topologySpec: {
          vpcCidr: '10.96.20.0/24',
          networkZones: [
            {
              key: 'zone-1',
              name: 'Zone 1',
              purpose: 'public-entry',
              cidr: '10.96.20.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'Entry Host',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.96.20.10',
              exposePublic: true,
            },
          ],
          publicEntry: {
            hostKey: 'ecs-1',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      });

      const varsFilePath = path.join(workspacesRootDir, 'range-instance-legacy-singleton', 'range.auto.tfvars.json');
      const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('Action=DescribeAvailableResource');
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain('Action=DescribeImages');
      expect(renderedVariables.instance_type).toBe('ecs.u1-c1m2.large');
      expect(renderedVariables.image_id).toBe('ubuntu_24_04_x64_20G_alibase_20260615.vhd');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('resolves host instance types via default zone fast path without DescribeZones or DescribePrice', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-zone-fast-path-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          TotalCount: 2,
          InstanceTypes: {
            InstanceType: [
              { InstanceTypeId: 'ecs.e-c1m1.large', CpuArchitecture: 'x86_64' },
              { InstanceTypeId: 'ecs.c7.large', CpuArchitecture: 'x86_64' },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AvailableZones: {
            AvailableZone: [
              {
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [
                          { Value: 'ecs.e-c1m1.large', Status: 'Available' },
                          { Value: 'ecs.c7.large', Status: 'Available' },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      } as Response);

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.99.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-zone-fast-path',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof global.fetch;

    try {
      const provisioner = new OpenTofuRangeProvisioner({
        runner,
        projectRootDir: tempRootDir,
        workspacesRootDir,
        env: {
          ALICLOUD_REGION: 'cn-hangzhou',
          ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
          ALICLOUD_ACCESS_KEY: 'test-ak',
          ALICLOUD_SECRET_KEY: 'test-sk',
          ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
          OPENTOFU_INSTANCE_TYPE: 'auto',
          OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        },
      });

      await provisioner.create({
        rangeInstanceId: 'range-instance-zone-fast-path',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
        reportStep: async () => undefined,
        topologySpec: {
          vpcCidr: '10.99.0.0/16',
          networkZones: [
            {
              key: 'zone-1',
              name: 'Zone 1',
              purpose: 'public-entry',
              cidr: '10.99.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'ECS 1',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.99.10.10',
              exposePublic: true,
            },
            {
              key: 'ecs-2',
              name: 'ECS 2',
              zoneKey: 'zone-1',
              role: 'app',
              privateIp: '10.99.10.20',
              exposePublic: false,
            },
          ],
          publicEntry: {
            hostKey: 'ecs-1',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          topology: {
            vpcCidr: '10.99.0.0/16',
            publicEntryHostKey: 'ecs-1',
            networkZoneKeys: ['zone-1'],
            hostKeys: ['ecs-1', 'ecs-2'],
          },
          resources: [
            {
              id: 'ecs-1',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'ECS 1',
                zoneKey: 'zone-1',
                role: 'entry',
                privateIp: '10.99.10.10',
                exposePublic: true,
                cpu: 2,
                memory: 2,
              },
            },
            {
              id: 'ecs-2',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'ECS 2',
                zoneKey: 'zone-1',
                role: 'app',
                privateIp: '10.99.10.20',
                exposePublic: false,
                instanceTypeStrategy: {
                  mode: 'fixed',
                  instanceType: 'ecs.c7.large',
                },
              },
            },
          ],
        },
      });

      const varsFilePath = path.join(
        workspacesRootDir,
        'range-instance-zone-fast-path',
        'range.auto.tfvars.json',
      );
      const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

      expect(renderedVariables.zone_id).toBe('cn-hangzhou-h');
      expect(renderedVariables.hosts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'ecs-1', instance_type: 'ecs.e-c1m1.large' }),
          expect.objectContaining({ key: 'ecs-2', instance_type: 'ecs.c7.large' }),
        ]),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('Action=DescribeZones'))).toBe(false);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('Action=DescribePrice'))).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('resolves auto instance types through explicit zone scheduling with the provisioner disk category', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-zone-explicit-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const wrappedResolver = jest.fn().mockResolvedValue('should-not-be-used');
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          TotalCount: 2,
          InstanceTypes: {
            InstanceType: [
              { InstanceTypeId: 'ecs.e-c1m1.large', CpuArchitecture: 'x86_64' },
              { InstanceTypeId: 'ecs.c7.large', CpuArchitecture: 'x86_64' },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AvailableZones: {
            AvailableZone: [
              {
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [
                          { Value: 'ecs.e-c1m1.large', Status: 'Available' },
                          { Value: 'ecs.c7.large', Status: 'Available' },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      } as Response);

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.99.20.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-zone-explicit',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const originalFetch = global.fetch;
    const originalSystemDiskCategory = process.env.OPENTOFU_SYSTEM_DISK_CATEGORY;
    global.fetch = fetchMock as typeof global.fetch;
    process.env.OPENTOFU_SYSTEM_DISK_CATEGORY = 'cloud_efficiency';

    try {
      const provisioner = new OpenTofuRangeProvisioner({
        runner,
        projectRootDir: tempRootDir,
        workspacesRootDir,
        availableInstanceTypeResolver: wrappedResolver,
        enableZoneScheduling: true,
        env: {
          ALICLOUD_REGION: 'cn-hangzhou',
          ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
          ALICLOUD_ACCESS_KEY: 'test-ak',
          ALICLOUD_SECRET_KEY: 'test-sk',
          ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
          OPENTOFU_INSTANCE_TYPE: 'auto',
          OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
          OPENTOFU_SYSTEM_DISK_CATEGORY: 'cloud_ssd',
        },
      });

      await provisioner.create({
        rangeInstanceId: 'range-instance-zone-explicit',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
        reportStep: async () => undefined,
        topologySpec: {
          vpcCidr: '10.99.20.0/24',
          networkZones: [
            {
              key: 'zone-1',
              name: 'Zone 1',
              purpose: 'public-entry',
              cidr: '10.99.20.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'ECS 1',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.99.20.10',
              exposePublic: true,
            },
          ],
          publicEntry: {
            hostKey: 'ecs-1',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          topology: {
            vpcCidr: '10.99.20.0/24',
            publicEntryHostKey: 'ecs-1',
            networkZoneKeys: ['zone-1'],
            hostKeys: ['ecs-1'],
          },
          resources: [
            {
              id: 'ecs-1',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'ECS 1',
                zoneKey: 'zone-1',
                role: 'entry',
                privateIp: '10.99.20.10',
                exposePublic: true,
                instanceTypeStrategy: {
                  mode: 'auto',
                  preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.c7.large'],
                },
              },
            },
          ],
        },
      });

      const varsFilePath = path.join(workspacesRootDir, 'range-instance-zone-explicit', 'range.auto.tfvars.json');
      const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

      expect(wrappedResolver).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain('SystemDiskCategory=cloud_ssd');
      expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain('SystemDiskCategory=cloud_efficiency');
      expect(renderedVariables.instance_type).toBe('ecs.e-c1m1.large');
    } finally {
      global.fetch = originalFetch;
      if (originalSystemDiskCategory === undefined) {
        delete process.env.OPENTOFU_SYSTEM_DISK_CATEGORY;
      } else {
        process.env.OPENTOFU_SYSTEM_DISK_CATEGORY = originalSystemDiskCategory;
      }
    }
  });

  it('falls back to discovered zones and instance types after the default zone fails feasibility', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-zone-fallback-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          TotalCount: 2,
          InstanceTypes: {
            InstanceType: [
              { InstanceTypeId: 'ecs.e-c1m1.large', CpuArchitecture: 'x86_64' },
              { InstanceTypeId: 'ecs.c7.large', CpuArchitecture: 'x86_64' },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AvailableZones: {
            AvailableZone: [
              {
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [{ Value: 'ecs.e-c1m1.large', Status: 'Available' }],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          Zones: {
            Zone: [{ ZoneId: 'cn-hangzhou-i', Status: 'Available' }],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AvailableZones: {
            AvailableZone: [
              {
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [
                          { Value: 'ecs.e-c1m1.large', Status: 'Available' },
                          { Value: 'ecs.c7.large', Status: 'Available' },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          PriceInfo: { Price: { TradePrice: 0.3 } },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          PriceInfo: { Price: { TradePrice: 0.5 } },
        }),
      } as Response);

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.100.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-zone-fallback',
            selected_zone_id: 'cn-hangzhou-i',
            attempted_zones: [
              {
                zone_id: 'cn-hangzhou-g',
                can_create_all_hosts: false,
                estimated_total_price: null,
                reason: 'Host ecs-2 has no saleable X86 on-demand candidate',
              },
              {
                zone_id: 'cn-hangzhou-i',
                can_create_all_hosts: true,
                estimated_total_price: 0.8,
              },
            ],
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof global.fetch;

    try {
      const provisioner = new OpenTofuRangeProvisioner({
        runner,
        projectRootDir: tempRootDir,
        workspacesRootDir,
        env: {
          ALICLOUD_REGION: 'cn-hangzhou',
          ALICLOUD_ZONE_ID: 'cn-hangzhou-g',
          ALICLOUD_ACCESS_KEY: 'test-ak',
          ALICLOUD_SECRET_KEY: 'test-sk',
          ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
          OPENTOFU_INSTANCE_TYPE: 'auto',
          OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        },
      });

      const result = await provisioner.create({
        rangeInstanceId: 'range-instance-zone-fallback',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
        reportStep: async () => undefined,
        topologySpec: {
          vpcCidr: '10.100.0.0/16',
          networkZones: [
            {
              key: 'zone-1',
              name: 'Zone 1',
              purpose: 'public-entry',
              cidr: '10.100.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'ECS 1',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.100.10.10',
              exposePublic: true,
            },
            {
              key: 'ecs-2',
              name: 'ECS 2',
              zoneKey: 'zone-1',
              role: 'app',
              privateIp: '10.100.10.20',
              exposePublic: false,
            },
          ],
          publicEntry: {
            hostKey: 'ecs-1',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          topology: {
            vpcCidr: '10.100.0.0/16',
            publicEntryHostKey: 'ecs-1',
            networkZoneKeys: ['zone-1'],
            hostKeys: ['ecs-1', 'ecs-2'],
          },
          resources: [
            {
              id: 'ecs-1',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'ECS 1',
                zoneKey: 'zone-1',
                role: 'entry',
                privateIp: '10.100.10.10',
                exposePublic: true,
                cpu: 2,
                memory: 2,
              },
            },
            {
              id: 'ecs-2',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'ECS 2',
                zoneKey: 'zone-1',
                role: 'app',
                privateIp: '10.100.10.20',
                exposePublic: false,
                instanceTypeStrategy: {
                  mode: 'fixed',
                  instanceType: 'ecs.c7.large',
                },
              },
            },
          ],
        },
      });

      const varsFilePath = path.join(
        workspacesRootDir,
        'range-instance-zone-fallback',
        'range.auto.tfvars.json',
      );
      const generatedVariablesTfPath = path.join(
        workspacesRootDir,
        'range-instance-zone-fallback',
        'variables.tf',
      );
      const moduleVariablesTfPath = path.resolve(
        __dirname,
        '../../../infra/opentofu/modules/alicloud-enterprise-range/variables.tf',
      );
      const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));
      const generatedVariablesTf = await fs.readFile(generatedVariablesTfPath, 'utf8');
      const moduleVariablesTf = await fs.readFile(moduleVariablesTfPath, 'utf8');

      expect(renderedVariables.zone_id).toBe('cn-hangzhou-i');
      expect(renderedVariables).not.toHaveProperty('selected_zone_id');
      expect(renderedVariables).not.toHaveProperty('attempted_zones');
      expect(renderedVariables.runtime_selections.attempted_zones).toEqual([
        {
          zone_id: 'cn-hangzhou-g',
          can_create_all_hosts: false,
          estimated_total_price: null,
          reason: 'Host ecs-2 has no saleable X86 on-demand candidate',
        },
        {
          zone_id: 'cn-hangzhou-i',
          can_create_all_hosts: true,
          estimated_total_price: 0.8,
        },
      ]);
      expect(generatedVariablesTf).toContain('attempted_zones = optional(list(object({');
      expect(moduleVariablesTf).toContain('attempted_zones = optional(list(object({');
      expect(renderedVariables.hosts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'ecs-1', instance_type: 'ecs.e-c1m1.large' }),
          expect.objectContaining({ key: 'ecs-2', instance_type: 'ecs.c7.large' }),
        ]),
      );
      expect(result.resourceSummary.selectedZoneId).toBe('cn-hangzhou-i');
      expect(result.resourceSummary.attemptedZones).toEqual([
        {
          zoneId: 'cn-hangzhou-g',
          canCreateAllHosts: false,
          estimatedTotalPrice: null,
          reason: 'Host ecs-2 has no saleable X86 on-demand candidate',
        },
        {
          zoneId: 'cn-hangzhou-i',
          canCreateAllHosts: true,
          estimatedTotalPrice: 0.8,
        },
      ]);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('Action=DescribeZones'))).toBe(true);
      expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('Action=DescribePrice'))).toHaveLength(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('ranks feasible zones by estimated total price', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-zone-ranking-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          TotalCount: 2,
          InstanceTypes: {
            InstanceType: [
              { InstanceTypeId: 'ecs.g7.large', CpuArchitecture: 'x86_64' },
              { InstanceTypeId: 'ecs.c7.large', CpuArchitecture: 'x86_64' },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AvailableZones: {
            AvailableZone: [
              {
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [{ Value: 'ecs.g7.large', Status: 'Available' }],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          Zones: {
            Zone: [
              { ZoneId: 'cn-hangzhou-h', Status: 'Available' },
              { ZoneId: 'cn-hangzhou-i', Status: 'Available' },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AvailableZones: {
            AvailableZone: [
              {
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [
                          { Value: 'ecs.g7.large', Status: 'Available' },
                          { Value: 'ecs.c7.large', Status: 'Available' },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          PriceInfo: { Price: { TradePrice: 0.9 } },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          PriceInfo: { Price: { TradePrice: 0.4 } },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          AvailableZones: {
            AvailableZone: [
              {
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: [
                          { Value: 'ecs.g7.large', Status: 'Available' },
                          { Value: 'ecs.c7.large', Status: 'Available' },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          PriceInfo: { Price: { TradePrice: 0.7 } },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          PriceInfo: { Price: { TradePrice: 0.2 } },
        }),
      } as Response);

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.101.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-zone-ranking',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof global.fetch;

    try {
      const provisioner = new OpenTofuRangeProvisioner({
        runner,
        projectRootDir: tempRootDir,
        workspacesRootDir,
        env: {
          ALICLOUD_REGION: 'cn-hangzhou',
          ALICLOUD_ZONE_ID: 'cn-hangzhou-g',
          ALICLOUD_ACCESS_KEY: 'test-ak',
          ALICLOUD_SECRET_KEY: 'test-sk',
          ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
          OPENTOFU_INSTANCE_TYPE: 'auto',
          OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        },
      });

      await provisioner.create({
        rangeInstanceId: 'range-instance-zone-ranking',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
        reportStep: async () => undefined,
        topologySpec: {
          vpcCidr: '10.101.0.0/16',
          networkZones: [
            {
              key: 'zone-1',
              name: 'Zone 1',
              purpose: 'public-entry',
              cidr: '10.101.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'ECS 1',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.101.10.10',
              exposePublic: true,
            },
            {
              key: 'ecs-2',
              name: 'ECS 2',
              zoneKey: 'zone-1',
              role: 'app',
              privateIp: '10.101.10.20',
              exposePublic: false,
            },
          ],
          publicEntry: {
            hostKey: 'ecs-1',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          topology: {
            vpcCidr: '10.101.0.0/16',
            publicEntryHostKey: 'ecs-1',
            networkZoneKeys: ['zone-1'],
            hostKeys: ['ecs-1', 'ecs-2'],
          },
          resources: [
            {
              id: 'ecs-1',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'ECS 1',
                zoneKey: 'zone-1',
                role: 'entry',
                privateIp: '10.101.10.10',
                exposePublic: true,
                instanceTypeStrategy: {
                  mode: 'auto',
                  preferredInstanceTypes: ['ecs.g7.large', 'ecs.c7.large'],
                },
              },
            },
            {
              id: 'ecs-2',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'ECS 2',
                zoneKey: 'zone-1',
                role: 'app',
                privateIp: '10.101.10.20',
                exposePublic: false,
                instanceTypeStrategy: {
                  mode: 'fixed',
                  instanceType: 'ecs.c7.large',
                },
              },
            },
          ],
        },
      });

      const varsFilePath = path.join(
        workspacesRootDir,
        'range-instance-zone-ranking',
        'range.auto.tfvars.json',
      );
      const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

      expect(renderedVariables.zone_id).toBe('cn-hangzhou-i');
      expect(renderedVariables.hosts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'ecs-1', instance_type: 'ecs.c7.large' }),
          expect.objectContaining({ key: 'ecs-2', instance_type: 'ecs.c7.large' }),
        ]),
      );
      expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('Action=DescribePrice'))).toHaveLength(4);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('renders a distinct image ID for each host without using the global runtime image resolver', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-host-image-conflict-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const availableInstanceTypeResolver = jest.fn().mockResolvedValue('should-not-be-used');
    const availableImageIdResolver = jest.fn().mockResolvedValue('should-not-be-used');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.97.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-host-image-conflict',
            subnet_ids: { 'zone-1': 'vsw-zone1' },
            host_ids: { 'ecs-1': 'i-ecs1', 'ecs-2': 'i-ecs2' },
            eip_allocation_id: 'eip-host-image-conflict',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      enableZoneScheduling: false,
      availableInstanceTypeResolver,
      availableImageIdResolver,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
        OPENTOFU_INSTANCE_TYPE: 'auto',
        OPENTOFU_IMAGE_ID: 'auto',
      },
    });

    await provisioner.create({
        rangeInstanceId: 'range-instance-host-image-conflict',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
        reportStep: async () => undefined,
        topologySpec: {
          vpcCidr: '10.97.0.0/16',
          networkZones: [
            {
              key: 'zone-1',
              name: 'Zone 1',
              purpose: 'public-entry',
              cidr: '10.97.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'ECS 1',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.97.10.10',
              exposePublic: true,
            },
            {
              key: 'ecs-2',
              name: 'ECS 2',
              zoneKey: 'zone-1',
              role: 'app',
              privateIp: '10.97.10.20',
              exposePublic: false,
            },
          ],
          publicEntry: {
            hostKey: 'ecs-1',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
        topologyGraph: {
          schemaVersion: '2.0.0',
          nodes: [
            {
              id: 'ecs-1',
              kind: 'ecs',
              data: {
                imageId: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
                imageStrategy: { mode: 'fixed', imageId: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd' },
              },
            },
            {
              id: 'ecs-2',
              kind: 'ecs',
              data: {
                imageId: 'debian_12_14_x64_20G_alibase_20260609.vhd',
                imageStrategy: { mode: 'fixed', imageId: 'debian_12_14_x64_20G_alibase_20260609.vhd' },
              },
            },
          ],
          edges: [],
        },
        compiledProvisionSpec: {
          schemaVersion: '1.0.0',
          topology: {
            vpcCidr: '10.97.0.0/16',
            entryHostKey: 'ecs-1',
          },
          networkZones: [
            {
              key: 'zone-1',
              name: 'Zone 1',
              cidr: '10.97.10.0/24',
              purpose: 'public-entry',
              isPublicEntry: true,
              routeRole: 'entry',
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'ECS 1',
              role: 'entry',
              zoneKey: 'zone-1',
              primaryPrivateIp: '10.97.10.10',
              exposePublic: true,
              networkInterfaces: [{ deviceIndex: 0, zoneKey: 'zone-1', privateIp: '10.97.10.10' }],
            },
            {
              key: 'ecs-2',
              name: 'ECS 2',
              role: 'app',
              zoneKey: 'zone-1',
              primaryPrivateIp: '10.97.10.20',
              exposePublic: false,
              networkInterfaces: [{ deviceIndex: 0, zoneKey: 'zone-1', privateIp: '10.97.10.20' }],
            },
          ],
          natGateways: [],
          eips: [{ key: 'entry-default', name: 'Entry EIP', bindTargetType: 'host', bindTargetKey: 'ecs-1', bandwidthMbps: 10 }],
          snatEntries: [],
          dnatEntries: [],
          securityGroupRules: [],
          aclRules: [],
          bootstrapScripts: [],
          runtimeSelections: {
            imagePolicies: {},
            instanceTypePolicies: {},
          },
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          topology: {
            vpcCidr: '10.97.0.0/16',
            publicEntryHostKey: 'ecs-1',
            networkZoneKeys: ['zone-1'],
            hostKeys: ['ecs-1', 'ecs-2'],
          },
          resources: [
            {
              id: 'ecs-1',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'ECS 1',
                zoneKey: 'zone-1',
                role: 'entry',
                privateIp: '10.97.10.10',
                exposePublic: true,
                instanceType: 'ecs.g7.large',
                imageId: 'm-unapproved-ecs-1',
              },
            },
            {
              id: 'ecs-2',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'ECS 2',
                zoneKey: 'zone-1',
                role: 'app',
                privateIp: '10.97.10.20',
                exposePublic: false,
                instanceType: 'ecs.c7.large',
                imageId: 'm-unapproved-ecs-2',
              },
            },
            {
              id: 'switch-1',
              type: 'switch',
              provider: 'alibaba_cloud',
              config: {
                label: 'Zone 1',
                zoneKey: 'zone-1',
                cidr: '10.97.10.0/24',
                purpose: 'public-entry',
              },
            },
          ],
        },
      });

    const varsFilePath = path.join(
      workspacesRootDir,
      'range-instance-host-image-conflict',
      'range.auto.tfvars.json',
    );
    const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

    expect(availableImageIdResolver).not.toHaveBeenCalled();
    expect(runner.init).toHaveBeenCalled();
    expect(renderedVariables.hosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'ecs-1',
          image_id: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        }),
        expect.objectContaining({
          key: 'ecs-2',
          image_id: 'debian_12_14_x64_20G_alibase_20260609.vhd',
        }),
      ]),
    );
  });

  it('does not treat generic host image strings as final executable image IDs', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-generic-host-image-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const availableImageIdResolver = jest
      .fn()
      .mockResolvedValue('ubuntu_24_04_x64_20G_alibase_20260615.vhd');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'entry',
            public_ip: '1.1.1.1',
            private_ip: '10.98.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-generic-host-image',
            subnet_ids: { 'zone-1': 'vsw-zone1' },
            host_ids: { 'ecs-1': 'i-ecs1' },
            eip_allocation_id: 'eip-generic-host-image',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      availableImageIdResolver,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
        OPENTOFU_INSTANCE_TYPE: 'ecs.g7.large',
        OPENTOFU_IMAGE_ID: 'auto',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-generic-host-image',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      reportStep: async () => undefined,
      topologySpec: {
        vpcCidr: '10.98.0.0/16',
        networkZones: [
          {
            key: 'zone-1',
            name: 'Zone 1',
            purpose: 'public-entry',
            cidr: '10.98.10.0/24',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'zone-1',
            role: 'entry',
            privateIp: '10.98.10.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-1',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledProvisionSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.98.0.0/16',
          entryHostKey: 'ecs-1',
        },
        networkZones: [
          {
            key: 'zone-1',
            name: 'Zone 1',
            cidr: '10.98.10.0/24',
            purpose: 'public-entry',
            isPublicEntry: true,
            routeRole: 'entry',
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            role: 'entry',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.98.10.10',
            exposePublic: true,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'zone-1', privateIp: '10.98.10.10' }],
          },
        ],
        natGateways: [],
        eips: [{ key: 'entry-default', name: 'Entry EIP', bindTargetType: 'host', bindTargetKey: 'ecs-1', bandwidthMbps: 10 }],
        snatEntries: [],
        dnatEntries: [],
        securityGroupRules: [],
        aclRules: [],
        bootstrapScripts: [],
        runtimeSelections: {
          imagePolicies: {},
          instanceTypePolicies: {},
        },
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.98.0.0/16',
          publicEntryHostKey: 'ecs-1',
          networkZoneKeys: ['zone-1'],
          hostKeys: ['ecs-1'],
        },
        resources: [
          {
            id: 'ecs-1',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: 'ECS 1',
              zoneKey: 'zone-1',
              role: 'entry',
              privateIp: '10.98.10.10',
              exposePublic: true,
              imageId: 'ubuntu',
            },
          },
          {
            id: 'switch-1',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: 'Zone 1',
              zoneKey: 'zone-1',
              cidr: '10.98.10.0/24',
              purpose: 'public-entry',
            },
          },
        ],
      },
    });

    const varsFilePath = path.join(
      workspacesRootDir,
      'range-instance-generic-host-image',
      'range.auto.tfvars.json',
    );
    const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

    expect(availableImageIdResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKey: 'test-ak',
        secretKey: 'test-sk',
        regionId: 'cn-hangzhou',
        preferredImageIds: expect.any(Array),
      }),
    );
    expect(renderedVariables.image_id).toBe('ubuntu_24_04_x64_20G_alibase_20260615.vhd');
    expect(renderedVariables.hosts).toEqual(
      expect.arrayContaining([
        expect.not.objectContaining({
          key: 'ecs-1',
          image_id: 'ubuntu',
        }),
      ]),
    );
  });

  it('resolves auto image ids before rendering variables when env requests automatic selection', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-auto-image-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    const availableImageIdResolver = jest
      .fn()
      .mockResolvedValue('ubuntu_24_04_x64_20G_alibase_20260615.vhd');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'dmz',
            public_ip: '1.1.1.1',
            private_ip: '10.91.10.10',
            ssh: 'ssh root@example.range',
          },
        },
        resource_summary: {
          value: {
            vpc_id: 'vpc-auto-image',
            subnet_ids: {
              dmz: 'vsw-dmz',
              office: 'vsw-office',
              server: 'vsw-server',
            },
            host_ids: {
              'dmz-entry': 'i-dmz',
              'office-client': 'i-office',
              'server-app': 'i-server',
            },
            eip_allocation_id: 'eip-auto-image',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      availableImageIdResolver,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
        OPENTOFU_INSTANCE_TYPE: 'ecs.u1-c1m2.large',
        OPENTOFU_IMAGE_ID: 'auto',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-auto-image',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      reportStep: async () => undefined,
      topologySpec: {
        vpcCidr: '10.91.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.91.10.0/24',
            isPublicEntry: true,
          },
          {
            key: 'office',
            name: 'Office',
            purpose: 'user-workstations',
            cidr: '10.91.20.0/24',
          },
          {
            key: 'server',
            name: 'Server',
            purpose: 'application-servers',
            cidr: '10.91.30.0/24',
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.91.10.10',
            exposePublic: true,
          },
          {
            key: 'office-client',
            name: 'Office Client',
            zoneKey: 'office',
            role: 'workstation',
            privateIp: '10.91.20.10',
          },
          {
            key: 'server-app',
            name: 'Server App',
            zoneKey: 'server',
            role: 'app',
            privateIp: '10.91.30.10',
          },
        ],
        publicEntry: {
          hostKey: 'dmz-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    const varsFilePath = path.join(
      workspacesRootDir,
      'range-instance-auto-image',
      'range.auto.tfvars.json',
    );
    const renderedVariables = JSON.parse(await fs.readFile(varsFilePath, 'utf8'));

    expect(availableImageIdResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKey: 'test-ak',
        secretKey: 'test-sk',
        regionId: 'cn-hangzhou',
        preferredImageIds: expect.arrayContaining([
          'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
          'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
        ]),
      }),
    );
    expect(renderedVariables.image_id).toBe('ubuntu_24_04_x64_20G_alibase_20260615.vhd');
  });

  it('does not pass proxy environment variables to the OpenTofu runner by default', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-proxy-env-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(path.join(moduleDir, 'outputs.tf'), 'output "public_ip" { value = "1.1.1.1" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: {
          value: {
            host_role: 'dmz',
            public_ip: '1.1.1.1',
            private_ip: '10.92.10.10',
            ssh: 'ssh root@example.range',
          },
        },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };

    const provisioner = new OpenTofuRangeProvisioner({
      runner,
      projectRootDir: tempRootDir,
      workspacesRootDir,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
        OPENTOFU_INSTANCE_TYPE: 'ecs.u1-c1m2.large',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        HTTPS_PROXY: 'http://127.0.0.1:7897',
        HTTP_PROXY: 'http://127.0.0.1:7897',
        ALL_PROXY: 'socks5://127.0.0.1:7897',
        https_proxy: 'http://127.0.0.1:7897',
        http_proxy: 'http://127.0.0.1:7897',
        all_proxy: 'socks5://127.0.0.1:7897',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-proxy-env',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
      reportStep: async () => undefined,
      topologySpec: {
        vpcCidr: '10.92.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.92.10.0/24',
            isPublicEntry: true,
          },
          {
            key: 'office',
            name: 'Office',
            purpose: 'user-workstations',
            cidr: '10.92.20.0/24',
          },
          {
            key: 'server',
            name: 'Server',
            purpose: 'application-servers',
            cidr: '10.92.30.0/24',
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.92.10.10',
            exposePublic: true,
          },
          {
            key: 'office-client',
            name: 'Office Client',
            zoneKey: 'office',
            role: 'workstation',
            privateIp: '10.92.20.10',
          },
          {
            key: 'server-app',
            name: 'Server App',
            zoneKey: 'server',
            role: 'app',
            privateIp: '10.92.30.10',
          },
        ],
        publicEntry: {
          hostKey: 'dmz-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
    });

    expect(runner.init).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.not.objectContaining({
          HTTPS_PROXY: expect.any(String),
          HTTP_PROXY: expect.any(String),
          ALL_PROXY: expect.any(String),
          https_proxy: expect.any(String),
          http_proxy: expect.any(String),
          all_proxy: expect.any(String),
        }),
      }),
    );
  });

  it('does not pass unrelated parent environment variables to the OpenTofu runner', async () => {
    const originalUnrelatedEnv = process.env.UNRELATED_PARENT_ENV;
    process.env.UNRELATED_PARENT_ENV = 'do-not-pass-through';

    try {
      const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-parent-env-'));
      const moduleDir = path.join(tempRootDir, 'infra', 'module');
      const workspacesRootDir = path.join(tempRootDir, 'workspaces');
      const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');

      await fs.mkdir(moduleDir, { recursive: true });
      await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
      await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

      const runner = {
        init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
        validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
        plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
        apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
        output: jest.fn().mockResolvedValue({
          public_entry: {
            value: {
              host_role: 'dmz',
              public_ip: '1.1.1.1',
              private_ip: '10.93.10.10',
              ssh: 'ssh root@example.range',
            },
          },
        }),
        destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
      };

      const provisioner = new OpenTofuRangeProvisioner({
        runner,
        projectRootDir: tempRootDir,
        workspacesRootDir,
        env: {
          ALICLOUD_REGION: 'cn-hangzhou',
          ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
          ALICLOUD_ACCESS_KEY: 'test-ak',
          ALICLOUD_SECRET_KEY: 'test-sk',
          ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
          OPENTOFU_INSTANCE_TYPE: 'ecs.u1-c1m2.large',
          OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        },
      });

      await provisioner.create({
        rangeInstanceId: 'range-instance-parent-env',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
      runtimeCredentials: testRuntimeCredentials,
        reportStep: async () => undefined,
        topologySpec: {
          vpcCidr: '10.93.0.0/16',
          networkZones: [
            {
              key: 'dmz',
              name: 'DMZ',
              purpose: 'public-entry',
              cidr: '10.93.10.0/24',
              isPublicEntry: true,
            },
          ],
          hosts: [
            {
              key: 'dmz-entry',
              name: 'DMZ Entry',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.93.10.10',
              exposePublic: true,
            },
          ],
          publicEntry: {
            hostKey: 'dmz-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      });

      const initEnv = runner.init.mock.calls[0]?.[0]?.env;

      expect(initEnv).toEqual(
        expect.objectContaining({
          ALICLOUD_ACCESS_KEY: 'test-ak',
          ALICLOUD_SECRET_KEY: 'test-sk',
          ALICLOUD_REGION: 'cn-hangzhou',
          TF_CLI_CONFIG_FILE: expect.stringContaining(path.join(workspacesRootDir, 'provider-mirror')),
        }),
      );
      expect(initEnv).not.toHaveProperty('UNRELATED_PARENT_ENV');
    } finally {
      if (originalUnrelatedEnv === undefined) {
        delete process.env.UNRELATED_PARENT_ENV;
      } else {
        process.env.UNRELATED_PARENT_ENV = originalUnrelatedEnv;
      }
    }
  });

  it('defaults to OpenTofu and supports an explicit dry-run provisioner mode', () => {
    const dryRunProvisioner = createRangeProvisionerFromEnv({
      projectRootDir: '/tmp/project',
      env: {
        RANGE_PROVISIONER_MODE: 'dry-run',
      },
    });
    const defaultProvisioner = createRangeProvisionerFromEnv({
      projectRootDir: '/tmp/project',
      env: {},
      runner: {
        init: jest.fn(),
        validate: jest.fn(),
        plan: jest.fn(),
        apply: jest.fn(),
        showPlan: jest.fn(),
        output: jest.fn(),
        destroy: jest.fn(),
      },
    });

    expect(dryRunProvisioner).toBeInstanceOf(DryRunRangeProvisioner);
    expect(defaultProvisioner).toBeInstanceOf(OpenTofuRangeProvisioner);
  });
});
