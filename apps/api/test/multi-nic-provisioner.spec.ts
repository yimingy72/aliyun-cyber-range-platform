import { fixturePlan, fixtureState, persistSuccessfulApply } from './opentofu-state-fixture';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';

const testRuntimeCredentials = new Proxy<Record<string, { username: string; password: string }>>(
  {},
  {
    get: () => ({ username: 'root', password: 'RuntimePassword123!' }),
  },
);

describe('OpenTofuRangeProvisioner multi-NIC scheduling', () => {
  it('rejects a fixed environment type that cannot satisfy the requested network-interface count', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-multi-nic-capacity-override-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: { value: { host_role: 'entry', private_ip: '10.90.10.10' } },
        resource_summary: { value: { vpc_id: 'vpc-multi-nic' } },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('Action=DescribeInstanceTypes')) {
        return {
          ok: true,
          json: async () => ({
            TotalCount: 2,
            InstanceTypes: {
              InstanceType: [
                { InstanceTypeId: 'ecs.e-c1m1.large', CpuArchitecture: 'x86_64', CpuCoreCount: 2, MemorySize: 2, EniQuantity: 2 },
                { InstanceTypeId: 'ecs.c6.xlarge', CpuArchitecture: 'x86_64', CpuCoreCount: 4, MemorySize: 8, EniQuantity: 3 },
              ],
            },
          }),
        } as Response;
      }

      if (url.includes('Action=DescribeAvailableResource')) {
        return {
          ok: true,
          json: async () => ({
            AvailableZones: {
              AvailableZone: {
                AvailableResources: {
                  AvailableResource: {
                    Type: 'InstanceType',
                    SupportedResources: {
                      SupportedResource: [
                        { Value: 'ecs.e-c1m1.large', Status: 'Available' },
                        { Value: 'ecs.c6.xlarge', Status: 'Available' },
                      ],
                    },
                  },
                },
              },
            },
          }),
        } as Response;
      }

      if (url.includes('Action=DescribeZones')) {
        return {
          ok: true,
          json: async () => ({ Zones: { Zone: [{ ZoneId: 'cn-hangzhou-h' }] } }),
        } as Response;
      }

      if (url.includes('Action=DescribePrice') && url.includes('InstanceType=ecs.c6.xlarge')) {
        return { ok: true, json: async () => ({ PriceInfo: { Price: { TradePrice: 0.7898 } } }) } as Response;
      }

      throw new Error(`Unexpected request: ${url}`);
    });
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
          OPENTOFU_INSTANCE_TYPE: 'ecs.e-c1m1.large',
          OPENTOFU_IMAGE_ID: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
          OPENTOFU_SYSTEM_DISK_CATEGORY: 'cloud_essd',
        },
      });

      await expect(provisioner.create({
        rangeInstanceId: 'range-multi-nic-capacity-override',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
        runtimeCredentials: testRuntimeCredentials,
        reportStep: async () => undefined,
        topologySpec: {
          vpcCidr: '10.90.0.0/16',
          networkZones: [
            { key: 'zone-a', name: 'Zone A', purpose: 'entry', cidr: '10.90.10.0/24', isPublicEntry: true },
            { key: 'zone-b', name: 'Zone B', purpose: 'pivot', cidr: '10.90.20.0/24', isPublicEntry: false },
            { key: 'zone-c', name: 'Zone C', purpose: 'target', cidr: '10.90.30.0/24', isPublicEntry: false },
          ],
          hosts: [
            { key: 'pivot-host', name: 'Pivot Host', zoneKey: 'zone-a', role: 'entry', privateIp: '10.90.10.10', exposePublic: true },
          ],
          publicEntry: { hostKey: 'pivot-host', protocols: [{ protocol: 'ssh', port: 22 }] },
        },
        compiledProvisionSpec: {
          topology: { vpcCidr: '10.90.0.0/16', entryHostKey: 'pivot-host' },
          networkZones: [],
          hosts: [
            {
              key: 'pivot-host',
              name: 'Pivot Host',
              role: 'entry',
              zoneKey: 'zone-a',
              primaryPrivateIp: '10.90.10.10',
              instanceTypePolicyKey: 'pivot-host-instance-type-policy',
              networkInterfaces: [
                { deviceIndex: 0, zoneKey: 'zone-a', privateIp: '10.90.10.10' },
                { deviceIndex: 1, zoneKey: 'zone-b', privateIp: '10.90.20.10' },
                { deviceIndex: 2, zoneKey: 'zone-c', privateIp: '10.90.30.10' },
              ],
            },
          ],
          natGateways: [],
          eips: [],
          snatEntries: [],
          dnatEntries: [],
          securityGroupRules: [],
          aclRules: [],
          bootstrapScripts: [],
          runtimeSelections: {
            imagePolicies: {},
            instanceTypePolicies: {
              'pivot-host-instance-type-policy': { mode: 'fixed', instanceType: 'ecs.e-c1m1.large' },
            },
          },
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          topology: {
            vpcCidr: '10.90.0.0/16',
            publicEntryHostKey: 'pivot-host',
            networkZoneKeys: ['zone-a', 'zone-b', 'zone-c'],
            hostKeys: ['pivot-host'],
          },
          resources: [
            {
              id: 'pivot-host',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'Pivot Host',
                zoneKey: 'zone-a',
                role: 'entry',
                privateIp: '10.90.10.10',
                exposePublic: true,
                cpu: 2,
                memory: 2,
                instanceType: 'ecs.e-c1m1.large',
                instanceTypeStrategy: { mode: 'fixed', instanceType: 'ecs.e-c1m1.large' },
              },
            },
          ],
        },
      })).rejects.toThrow('Host pivot-host has no saleable X86 on-demand candidate with 3 network interfaces');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('upgrades an economy fallback template when the host needs more than two network interfaces', async () => {
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-tofu-multi-nic-provisioner-'));
    const moduleDir = path.join(tempRootDir, 'infra', 'module');
    const workspacesRootDir = path.join(tempRootDir, 'workspaces');
    const providerZipPath = path.join(tempRootDir, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(providerZipPath, 'fake provider zip', 'utf8');

    const runner = {
      init: jest.fn().mockResolvedValue({ stdout: 'init ok', stderr: '' }),
      validate: jest.fn().mockResolvedValue({ stdout: 'validate ok', stderr: '' }),
      plan: jest.fn().mockResolvedValue({ stdout: 'plan ok', stderr: '' }),
      apply: jest.fn(persistSuccessfulApply),
      showPlan: jest.fn().mockResolvedValue(fixturePlan),
      output: jest.fn().mockResolvedValue({
        public_entry: { value: { host_role: 'entry', private_ip: '10.90.10.10' } },
        resource_summary: { value: { vpc_id: 'vpc-multi-nic' } },
      }),
      destroy: jest.fn().mockResolvedValue({ stdout: 'destroy ok', stderr: '' }),
    };
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('Action=DescribeInstanceTypes')) {
        return {
          ok: true,
          json: async () => ({
            TotalCount: 3,
            InstanceTypes: {
              InstanceType: [
                { InstanceTypeId: 'ecs.e-c1m1.large', CpuArchitecture: 'x86_64', CpuCoreCount: 2, MemorySize: 2, EniQuantity: 2 },
                { InstanceTypeId: 'ecs.c6.xlarge', CpuArchitecture: 'x86_64', CpuCoreCount: 4, MemorySize: 8, EniQuantity: 3 },
                { InstanceTypeId: 'ecs.hfc6.xlarge', CpuArchitecture: 'x86_64', CpuCoreCount: 4, MemorySize: 8, EniQuantity: 3 },
              ],
            },
          }),
        } as Response;
      }

      if (url.includes('Action=DescribeAvailableResource')) {
        return {
          ok: true,
          json: async () => ({
            AvailableZones: {
              AvailableZone: {
                AvailableResources: {
                  AvailableResource: {
                    Type: 'InstanceType',
                    SupportedResources: {
                      SupportedResource: [
                        { Value: 'ecs.e-c1m1.large', Status: 'Available' },
                        { Value: 'ecs.c6.xlarge', Status: 'Available' },
                        { Value: 'ecs.hfc6.xlarge', Status: 'Available' },
                      ],
                    },
                  },
                },
              },
            },
          }),
        } as Response;
      }

      if (url.includes('Action=DescribePrice') && url.includes('InstanceType=ecs.c6.xlarge')) {
        return { ok: true, json: async () => ({ PriceInfo: { Price: { TradePrice: 0.7898 } } }) } as Response;
      }

      if (url.includes('Action=DescribePrice') && url.includes('InstanceType=ecs.hfc6.xlarge')) {
        return { ok: true, json: async () => ({ PriceInfo: { Price: { TradePrice: 0.90563333 } } }) } as Response;
      }

      throw new Error(`Unexpected request: ${url}`);
    });
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
          OPENTOFU_SYSTEM_DISK_CATEGORY: 'cloud_essd',
        },
      });

      await provisioner.create({
        rangeInstanceId: 'range-multi-nic',
        templateModulePath: 'infra/module',
        allocatedCidr: null,
        runtimeCredentials: testRuntimeCredentials,
        reportStep: async () => undefined,
        topologySpec: {
          vpcCidr: '10.90.0.0/16',
          networkZones: [
            { key: 'zone-a', name: 'Zone A', purpose: 'entry', cidr: '10.90.10.0/24', isPublicEntry: true },
            { key: 'zone-b', name: 'Zone B', purpose: 'pivot', cidr: '10.90.20.0/24', isPublicEntry: false },
            { key: 'zone-c', name: 'Zone C', purpose: 'target', cidr: '10.90.30.0/24', isPublicEntry: false },
          ],
          hosts: [
            { key: 'pivot-host', name: 'Pivot Host', zoneKey: 'zone-a', role: 'entry', privateIp: '10.90.10.10', exposePublic: true },
          ],
          publicEntry: { hostKey: 'pivot-host', protocols: [{ protocol: 'ssh', port: 22 }] },
        },
        compiledProvisionSpec: {
          topology: { vpcCidr: '10.90.0.0/16', entryHostKey: 'pivot-host' },
          networkZones: [],
          hosts: [
            {
              key: 'pivot-host',
              name: 'Pivot Host',
              role: 'entry',
              zoneKey: 'zone-a',
              primaryPrivateIp: '10.90.10.10',
              instanceTypePolicyKey: 'pivot-host-instance-type-policy',
              networkInterfaces: [
                { deviceIndex: 0, zoneKey: 'zone-a', privateIp: '10.90.10.10' },
                { deviceIndex: 1, zoneKey: 'zone-b', privateIp: '10.90.20.10' },
                { deviceIndex: 2, zoneKey: 'zone-c', privateIp: '10.90.30.10' },
              ],
            },
          ],
          natGateways: [],
          eips: [],
          snatEntries: [],
          dnatEntries: [],
          securityGroupRules: [],
          aclRules: [],
          bootstrapScripts: [],
          runtimeSelections: {
            imagePolicies: {},
            instanceTypePolicies: {
              'pivot-host-instance-type-policy': {
                mode: 'prefer-list',
                preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m1.large'],
              },
            },
          },
        },
        compiledSpec: {
          schemaVersion: '1.0.0',
          topology: {
            vpcCidr: '10.90.0.0/16',
            publicEntryHostKey: 'pivot-host',
            networkZoneKeys: ['zone-a', 'zone-b', 'zone-c'],
            hostKeys: ['pivot-host'],
          },
          resources: [
            {
              id: 'pivot-host',
              type: 'host',
              provider: 'alibaba_cloud',
              config: {
                label: 'Pivot Host',
                zoneKey: 'zone-a',
                role: 'entry',
                privateIp: '10.90.10.10',
                exposePublic: true,
                cpu: 2,
                memory: 2,
                instanceType: 'ecs.e-c1m1.large',
                instanceTypeStrategy: {
                  mode: 'prefer-list',
                  preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m1.large'],
                },
              },
            },
          ],
        },
      });

      const variables = JSON.parse(
        await fs.readFile(path.join(workspacesRootDir, 'range-multi-nic', 'range.auto.tfvars.json'), 'utf8'),
      );
      expect(variables.hosts).toEqual([
        expect.objectContaining({ key: 'pivot-host', instance_type: 'ecs.c6.xlarge' }),
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
