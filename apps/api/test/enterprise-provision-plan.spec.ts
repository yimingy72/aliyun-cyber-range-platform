import { buildEnterpriseProvisionPlan } from '../src/provisioning/enterprise-provision-plan';

describe('buildEnterpriseProvisionPlan', () => {
  it('builds a stable enterprise provision plan from topologySpec', () => {
    const plan = buildEnterpriseProvisionPlan({
      rangeInstanceId: 'range-instance-1',
      templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
      allocatedCidr: null,
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
    });

    expect(plan).toEqual({
      resourceNamePrefix: 'range-range-ins',
      modulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
      entryHostKey: 'dmz-entry',
      topologySummary: {
        vpcCidr: '10.88.0.0/16',
        publicEntryHostKey: 'dmz-entry',
        networkZoneKeys: ['dmz', 'office', 'server'],
        hostKeys: ['dmz-entry', 'office-client', 'server-app'],
      },
      network: {
        vpcCidr: '10.88.0.0/16',
        dmzCidr: '10.88.10.0/24',
        officeCidr: '10.88.20.0/24',
        serverCidr: '10.88.30.0/24',
      },
      networkZones: [
        {
          key: 'dmz',
          name: 'DMZ',
          cidr: '10.88.10.0/24',
          purpose: 'public-entry',
          isPublicEntry: true,
        },
        {
          key: 'office',
          name: 'Office',
          cidr: '10.88.20.0/24',
          purpose: 'user-workstations',
          isPublicEntry: false,
        },
        {
          key: 'server',
          name: 'Server',
          cidr: '10.88.30.0/24',
          purpose: 'application-servers',
          isPublicEntry: false,
        },
      ],
      hostDefinitions: [
        {
          key: 'dmz-entry',
          name: 'DMZ Entry',
          zoneKey: 'dmz',
          privateIp: '10.88.10.10',
          role: 'entry',
          exposePublic: true,
        },
        {
          key: 'office-client',
          name: 'Office Client',
          zoneKey: 'office',
          privateIp: '10.88.20.10',
          role: 'workstation',
          exposePublic: false,
        },
        {
          key: 'server-app',
          name: 'Server App',
          zoneKey: 'server',
          privateIp: '10.88.30.10',
          role: 'app',
          exposePublic: false,
        },
      ],
      hosts: {
        publicEntry: expect.objectContaining({ key: 'dmz-entry', privateIp: '10.88.10.10' }),
        officePrimary: expect.objectContaining({ key: 'office-client', privateIp: '10.88.20.10' }),
        serverPrimary: expect.objectContaining({ key: 'server-app', privateIp: '10.88.30.10' }),
      },
    });
  });

  it('rejects mismatched allocatedCidr and template vpcCidr', () => {
    expect(() =>
      buildEnterpriseProvisionPlan({
        rangeInstanceId: 'range-instance-1',
        templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
        allocatedCidr: '10.99.0.0/16',
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
            { key: 'office', name: 'Office', purpose: 'user-workstations', cidr: '10.88.20.0/24' },
            { key: 'server', name: 'Server', purpose: 'application-servers', cidr: '10.88.30.0/24' },
          ],
          hosts: [
            { key: 'dmz-entry', name: 'DMZ Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.88.10.10', exposePublic: true },
            { key: 'office-client', name: 'Office Client', zoneKey: 'office', role: 'workstation', privateIp: '10.88.20.10' },
            { key: 'server-app', name: 'Server App', zoneKey: 'server', role: 'app', privateIp: '10.88.30.10' },
          ],
          publicEntry: {
            hostKey: 'dmz-entry',
            protocols: [{ protocol: 'ssh', port: 22 }],
          },
        },
      }),
    ).toThrow('Allocated CIDR 10.99.0.0/16 does not match template topology VPC CIDR 10.88.0.0/16');
  });

  it('reconstructs the enterprise plan from compiledSpec resources when topologySpec is missing', () => {
    const plan = buildEnterpriseProvisionPlan({
      rangeInstanceId: 'range-instance-2',
      templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
      allocatedCidr: null,
      compiledSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.77.0.0/16',
          publicEntryHostKey: 'host-dmz-entry',
          networkZoneKeys: ['dmz', 'office', 'server'],
          hostKeys: ['host-dmz-entry', 'host-office-client', 'host-server-app'],
        },
        resources: [
          {
            id: 'switch-dmz',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: 'DMZ 子网',
              zoneKey: 'dmz',
              cidr: '10.77.10.0/24',
              purpose: 'public-entry',
            },
          },
          {
            id: 'switch-office',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: '办公网子网',
              zoneKey: 'office',
              cidr: '10.77.20.0/24',
              purpose: 'user-workstations',
            },
          },
          {
            id: 'switch-server',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: '服务器区子网',
              zoneKey: 'server',
              cidr: '10.77.30.0/24',
              purpose: 'application-servers',
            },
          },
          {
            id: 'host-dmz-entry',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: 'DMZ 入口',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.77.10.10',
              exposePublic: true,
            },
          },
          {
            id: 'host-office-client',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: '办公网主机',
              zoneKey: 'office',
              role: 'workstation',
              privateIp: '10.77.20.10',
            },
          },
          {
            id: 'host-server-app',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: '服务器主机',
              zoneKey: 'server',
              role: 'app',
              privateIp: '10.77.30.10',
            },
          },
        ],
      },
    });

    expect(plan.topologySummary).toEqual({
      vpcCidr: '10.77.0.0/16',
      publicEntryHostKey: 'host-dmz-entry',
      networkZoneKeys: ['dmz', 'office', 'server'],
      hostKeys: ['host-dmz-entry', 'host-office-client', 'host-server-app'],
    });
    expect(plan.network).toEqual({
      vpcCidr: '10.77.0.0/16',
      dmzCidr: '10.77.10.0/24',
      officeCidr: '10.77.20.0/24',
      serverCidr: '10.77.30.0/24',
    });
    expect(plan.hosts.publicEntry).toEqual(
      expect.objectContaining({ key: 'host-dmz-entry', privateIp: '10.77.10.10' }),
    );
  });

  it('extracts nat gateways and eips from compiledSpec resources', () => {
    const plan = buildEnterpriseProvisionPlan({
      rangeInstanceId: 'range-instance-2',
      templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
      allocatedCidr: null,
      compiledSpec: {
        schemaVersion: '1.0.0',
        topology: {
          vpcCidr: '10.66.0.0/16',
          publicEntryHostKey: 'host-dmz-entry',
          networkZoneKeys: ['dmz', 'office', 'server'],
          hostKeys: ['host-dmz-entry', 'host-office-client', 'host-server-app'],
        },
        resources: [
          {
            id: 'switch-dmz',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: 'DMZ 子网',
              zoneKey: 'dmz',
              cidr: '10.66.10.0/24',
              purpose: 'public-entry',
            },
          },
          {
            id: 'switch-office',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: '办公网子网',
              zoneKey: 'office',
              cidr: '10.66.20.0/24',
              purpose: 'user-workstations',
            },
          },
          {
            id: 'switch-server',
            type: 'switch',
            provider: 'alibaba_cloud',
            config: {
              label: '服务器区子网',
              zoneKey: 'server',
              cidr: '10.66.30.0/24',
              purpose: 'application-servers',
            },
          },
          {
            id: 'host-dmz-entry',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: 'DMZ 入口',
              zoneKey: 'dmz',
              role: 'entry',
              privateIp: '10.66.10.10',
              exposePublic: true,
            },
          },
          {
            id: 'host-office-client',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: '办公网主机',
              zoneKey: 'office',
              role: 'workstation',
              privateIp: '10.66.20.10',
            },
          },
          {
            id: 'host-server-app',
            type: 'host',
            provider: 'alibaba_cloud',
            config: {
              label: '服务器主机',
              zoneKey: 'server',
              role: 'app',
              privateIp: '10.66.30.10',
            },
          },
          {
            id: 'nat-office',
            type: 'nat_gateway',
            provider: 'alibaba_cloud',
            config: {
              label: '办公网 NAT',
              zoneKey: 'office',
              snatEnabled: true,
            },
          },
          {
            id: 'eip-entry',
            type: 'eip',
            provider: 'alibaba_cloud',
            config: {
              label: '入口 EIP',
              bindTargetType: 'host',
              bindTargetKey: 'host-dmz-entry',
              bandwidthMbps: 30,
            },
          },
          {
            id: 'eip-office-nat',
            type: 'eip',
            provider: 'alibaba_cloud',
            config: {
              label: '办公 NAT EIP',
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
              label: '入口 SSH 放行',
              targetHostKey: 'host-dmz-entry',
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
              label: '办公区 ACL',
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

    expect(plan.natGateways).toEqual([
      {
        key: 'nat-office',
        name: '办公网 NAT',
        zoneKey: 'office',
        snatEnabled: true,
      },
    ]);
    expect(plan.eipDefinitions).toEqual([
      {
        key: 'eip-entry',
        name: '入口 EIP',
        bindTargetType: 'host',
        bindTargetKey: 'host-dmz-entry',
        bandwidthMbps: 30,
      },
      {
        key: 'eip-office-nat',
        name: '办公 NAT EIP',
        bindTargetType: 'nat_gateway',
        bindTargetKey: 'nat-office',
        bandwidthMbps: 50,
      },
    ]);
    expect(plan.securityGroupRules).toEqual([
      {
        key: 'sg-entry-ssh',
        name: '入口 SSH 放行',
        targetHostKey: 'host-dmz-entry',
        direction: 'ingress',
        policy: 'accept',
        protocol: 'tcp',
        portRange: '22/22',
        sourceCidr: '0.0.0.0/0',
        priority: 1,
      },
    ]);
    expect(plan.aclDefinitions).toEqual([
      {
        key: 'acl-office-inbound',
        name: '办公区 ACL',
        zoneKey: 'office',
        direction: 'inbound',
        policy: 'accept',
        protocol: 'tcp',
        portRange: '3389/3389',
        sourceCidr: '10.0.0.0/8',
        priority: 10,
      },
    ]);
  });
});
