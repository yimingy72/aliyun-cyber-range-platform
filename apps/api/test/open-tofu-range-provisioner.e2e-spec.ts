import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  OpenTofuRangeProvisioner,
  createRangeProvisionerFromEnv,
} from '../src/provisioning/open-tofu-range-provisioner';
import { DryRunRangeProvisioner } from '../src/provisioning/dry-run-range-provisioner';
import type { RangeProvisionStepEvent } from '../src/provisioning/provisioning.types';

describe('OpenTofuRangeProvisioner', () => {
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
      apply: jest.fn().mockResolvedValue({ stdout: 'apply ok', stderr: '' }),
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
        OPENTOFU_INSTANCE_PASSWORD: 'ChangeMe123!',
        OPENTOFU_ALLOWED_INGRESS_CIDR: '10.0.0.0/8',
      },
    });
    const stepEvents: RangeProvisionStepEvent[] = [];

    const result = await provisioner.create({
      rangeInstanceId: 'range-instance-1',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
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

    expect(await fs.readFile(path.join(workspaceDir, 'main.tf'), 'utf8')).toContain('instance_id');
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
          },
          {
            key: 'office-client',
            name: 'Office Client',
            zone_key: 'office',
            private_ip: '10.88.20.10',
            role: 'workstation',
            expose_public: false,
          },
          {
            key: 'server-app',
            name: 'Server App',
            zone_key: 'server',
            private_ip: '10.88.30.10',
            role: 'app',
            expose_public: false,
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
        instance_password: 'ChangeMe123!',
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
    expect(runner.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir,
        varsFilePath,
      }),
    );
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
      expect.objectContaining({ stepName: 'tofu_validate', status: 'running' }),
      expect.objectContaining({ stepName: 'tofu_validate', status: 'succeeded' }),
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
        eipAllocationId: 'eip-local',
        eipAllocationIds: {
          'eip-entry': 'eip-local',
          'eip-office-nat': 'eip-office',
        },
        hostIds: {
          'dmz-entry': 'i-dmz',
          'office-client': 'i-office',
          'server-app': 'i-server',
        },
        mode: 'opentofu',
        natGatewayIds: {
          'nat-office': 'ngw-office',
        },
        outputFilePath: path.join(workspaceDir, 'outputs.json'),
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

  it('reuses the dedicated workspace and runs init plus destroy with rendered variables', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-provisioner-destroy-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');

    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'main.tf'), 'output "instance_id" { value = "i-local" }\n', 'utf8');
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn(),
      apply: jest.fn(),
      output: jest.fn(),
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
        OPENTOFU_INSTANCE_PASSWORD: 'ChangeMe123!',
      },
    });
    const stepEvents: RangeProvisionStepEvent[] = [];

    await provisioner.destroy({
      rangeInstanceId: 'range-instance-2',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
      reportStep: async (event) => {
        stepEvents.push(event);
      },
      topologySpec: {
        vpcCidr: '10.89.0.0/16',
        networkZones: [
          {
            key: 'dmz',
            name: 'DMZ',
            purpose: 'public-entry',
            cidr: '10.89.10.0/24',
            isPublicEntry: true,
          },
          {
            key: 'office',
            name: 'Office',
            purpose: 'user-workstations',
            cidr: '10.89.20.0/24',
          },
          {
            key: 'server',
            name: 'Server',
            purpose: 'application-servers',
            cidr: '10.89.30.0/24',
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zoneKey: 'dmz',
            role: 'entry',
            privateIp: '10.89.10.10',
            exposePublic: true,
          },
          {
            key: 'office-client',
            name: 'Office Client',
            zoneKey: 'office',
            role: 'workstation',
            privateIp: '10.89.20.10',
          },
          {
            key: 'server-app',
            name: 'Server App',
            zoneKey: 'server',
            role: 'app',
            privateIp: '10.89.30.10',
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
            config: {
              label: 'DMZ',
              zoneKey: 'dmz',
              cidr: '10.88.10.0/24',
              purpose: 'public-entry',
            },
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
            config: {
              label: 'Server App',
              zoneKey: 'server',
              role: 'app',
              privateIp: '10.88.30.10',
            },
          },
          {
            id: 'nat-office',
            type: 'nat_gateway',
            provider: 'alibaba_cloud',
            config: {
              label: 'Office NAT',
              zoneKey: 'office',
              snatEnabled: true,
            },
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

    const workspaceDir = path.join(workspacesRootDir, 'range-instance-2');
    const varsFilePath = path.join(workspaceDir, 'range.auto.tfvars.json');

    expect(JSON.parse(await fs.readFile(varsFilePath, 'utf8'))).toEqual(
      expect.objectContaining({
        vpc_cidr: '10.89.0.0/16',
        entry_host_key: 'dmz-entry',
        network_zones: [
          {
            key: 'dmz',
            name: 'DMZ',
            cidr: '10.89.10.0/24',
            purpose: 'public-entry',
            is_public_entry: true,
          },
          {
            key: 'office',
            name: 'Office',
            cidr: '10.89.20.0/24',
            purpose: 'user-workstations',
            is_public_entry: false,
          },
          {
            key: 'server',
            name: 'Server',
            cidr: '10.89.30.0/24',
            purpose: 'application-servers',
            is_public_entry: false,
          },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            zone_key: 'dmz',
            private_ip: '10.89.10.10',
            role: 'entry',
            expose_public: true,
          },
          {
            key: 'office-client',
            name: 'Office Client',
            zone_key: 'office',
            private_ip: '10.89.20.10',
            role: 'workstation',
            expose_public: false,
          },
          {
            key: 'server-app',
            name: 'Server App',
            zone_key: 'server',
            private_ip: '10.89.30.10',
            role: 'app',
            expose_public: false,
          },
        ],
        dmz_cidr: '10.89.10.0/24',
        office_cidr: '10.89.20.0/24',
        server_cidr: '10.89.30.0/24',
      }),
    );
    expect(runner.init).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir,
      }),
    );
    expect(runner.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir,
        varsFilePath,
      }),
    );
    expect(runner.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir,
        varsFilePath,
      }),
    );
    expect(stepEvents).toEqual([
      expect.objectContaining({ stepName: 'render_template', status: 'running' }),
      expect.objectContaining({ stepName: 'render_template', status: 'succeeded' }),
      expect.objectContaining({ stepName: 'tofu_init', status: 'running' }),
      expect.objectContaining({ stepName: 'tofu_init', status: 'succeeded' }),
      expect.objectContaining({ stepName: 'tofu_validate', status: 'running' }),
      expect.objectContaining({ stepName: 'tofu_validate', status: 'succeeded' }),
      expect.objectContaining({ stepName: 'destroy', status: 'running' }),
      expect.objectContaining({ stepName: 'destroy', status: 'succeeded' }),
    ]);
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
        OPENTOFU_INSTANCE_PASSWORD: 'ChangeMe123!',
      },
    });
    const stepEvents: RangeProvisionStepEvent[] = [];

    await expect(
      provisioner.create({
        rangeInstanceId: 'range-instance-3',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
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
      apply: jest.fn().mockResolvedValue({ stdout: 'apply ok', stderr: '' }),
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
      availableInstanceTypeResolver,
      env: {
        ALICLOUD_REGION: 'cn-hangzhou',
        ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
        ALICLOUD_ACCESS_KEY: 'test-ak',
        ALICLOUD_SECRET_KEY: 'test-sk',
        ALICLOUD_PROVIDER_ZIP_PATH: providerZipPath,
        OPENTOFU_INSTANCE_TYPE: 'auto',
        OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        OPENTOFU_INSTANCE_PASSWORD: 'ChangeMe123!',
        OPENTOFU_SYSTEM_DISK_CATEGORY: 'cloud_essd',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-auto',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
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
      apply: jest.fn().mockResolvedValue({ stdout: 'apply ok', stderr: '' }),
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
        OPENTOFU_INSTANCE_PASSWORD: 'ChangeMe123!',
      },
    });

    await provisioner.create({
      rangeInstanceId: 'range-instance-auto-image',
      templateModulePath: 'infra/module',
      allocatedCidr: null,
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
      apply: jest.fn().mockResolvedValue({ stdout: 'apply ok', stderr: '' }),
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
        OPENTOFU_INSTANCE_PASSWORD: 'ChangeMe123!',
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

  it('switches between dry-run and OpenTofu provisioners from env mode', () => {
    const dryRunProvisioner = createRangeProvisionerFromEnv({
      projectRootDir: '/tmp/project',
      env: {},
    });
    const openTofuProvisioner = createRangeProvisionerFromEnv({
      projectRootDir: '/tmp/project',
      env: {
        RANGE_PROVISIONER_MODE: 'opentofu',
      },
      runner: {
        init: jest.fn(),
        validate: jest.fn(),
        plan: jest.fn(),
        apply: jest.fn(),
        output: jest.fn(),
        destroy: jest.fn(),
      },
    });

    expect(dryRunProvisioner).toBeInstanceOf(DryRunRangeProvisioner);
    expect(openTofuProvisioner).toBeInstanceOf(OpenTofuRangeProvisioner);
  });
});
