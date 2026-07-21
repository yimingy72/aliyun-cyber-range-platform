import { buildEnterpriseProvisionPlan } from '../src/provisioning/enterprise-provision-plan';

describe('buildEnterpriseProvisionPlan', () => {
  it('backfills platform SSH and HTTP rules for every ECS in a legacy template with no security-group rule intent', () => {
    const plan = buildEnterpriseProvisionPlan({
      rangeInstanceId: 'range-instance-legacy-defaults',
      templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
      allocatedCidr: null,
      topologySpec: {
        vpcCidr: '10.99.0.0/16',
        networkZones: [{ key: 'core', name: 'Core', purpose: 'business-zone', cidr: '10.99.1.0/24' }],
        hosts: [
          {
            key: 'ecs-entry',
            name: 'Entry ECS',
            zoneKey: 'core',
            role: 'entry',
            privateIp: '10.99.1.10',
            exposePublic: true,
          },
          {
            key: 'ecs-app',
            name: 'App ECS',
            zoneKey: 'core',
            role: 'app',
            privateIp: '10.99.1.11',
          },
        ],
        publicEntry: {
          hostKey: 'ecs-entry',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledProvisionSpec: {
        securityGroupRules: [],
      },
    });

    expect(plan.securityGroupRules).toEqual([
      {
        key: 'ecs-entry-default-ssh',
        name: 'ecs-entry default SSH',
        targetHostKey: 'ecs-entry',
        direction: 'ingress',
        policy: 'accept',
        protocol: 'tcp',
        portRange: '22/22',
        sourceCidr: '0.0.0.0/0',
        priority: 1,
      },
      {
        key: 'ecs-entry-default-http',
        name: 'ecs-entry default HTTP',
        targetHostKey: 'ecs-entry',
        direction: 'ingress',
        policy: 'accept',
        protocol: 'tcp',
        portRange: '80/80',
        sourceCidr: '0.0.0.0/0',
        priority: 1,
      },
      {
        key: 'ecs-app-default-ssh',
        name: 'ecs-app default SSH',
        targetHostKey: 'ecs-app',
        direction: 'ingress',
        policy: 'accept',
        protocol: 'tcp',
        portRange: '22/22',
        sourceCidr: '0.0.0.0/0',
        priority: 1,
      },
      {
        key: 'ecs-app-default-http',
        name: 'ecs-app default HTTP',
        targetHostKey: 'ecs-app',
        direction: 'ingress',
        policy: 'accept',
        protocol: 'tcp',
        portRange: '80/80',
        sourceCidr: '0.0.0.0/0',
        priority: 1,
      },
    ]);
  });

  it('keeps an explicitly saved empty security-group rule set empty', () => {
    const plan = buildEnterpriseProvisionPlan({
      rangeInstanceId: 'range-instance-custom-empty',
      templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
      allocatedCidr: null,
      topologySpec: {
        vpcCidr: '10.98.0.0/16',
        networkZones: [{ key: 'core', name: 'Core', purpose: 'business-zone', cidr: '10.98.1.0/24' }],
        hosts: [
          {
            key: 'ecs-custom',
            name: 'Custom ECS',
            zoneKey: 'core',
            role: 'entry',
            privateIp: '10.98.1.10',
            exposePublic: true,
          },
        ],
        publicEntry: {
          hostKey: 'ecs-custom',
          protocols: [{ protocol: 'ssh', port: 22 }],
        },
      },
      compiledProvisionSpec: {
        securityGroupRulesConfigured: true,
        securityGroupRules: [],
      },
    });

    expect(plan.securityGroupRules).toEqual([]);
  });

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

    expect(plan).toEqual(expect.objectContaining({
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
      hostDefinitions: expect.arrayContaining([
        expect.objectContaining({
          key: 'dmz-entry',
          name: 'DMZ Entry',
          zoneKey: 'dmz',
          privateIp: '10.88.10.10',
          role: 'entry',
          exposePublic: true,
        }),
        expect.objectContaining({
          key: 'office-client',
          name: 'Office Client',
          zoneKey: 'office',
          privateIp: '10.88.20.10',
          role: 'workstation',
          exposePublic: false,
        }),
        expect.objectContaining({
          key: 'server-app',
          name: 'Server App',
          zoneKey: 'server',
          privateIp: '10.88.30.10',
          role: 'app',
          exposePublic: false,
        }),
      ]),
      hosts: expect.objectContaining({
        publicEntry: expect.objectContaining({ key: 'dmz-entry', privateIp: '10.88.10.10' }),
        officePrimary: expect.objectContaining({ key: 'office-client', privateIp: '10.88.20.10' }),
        serverPrimary: expect.objectContaining({ key: 'server-app', privateIp: '10.88.30.10' }),
      }),
    }));
  });

  it('builds a stable enterprise provision plan from compiledProvisionSpec when legacy topology fields are absent', () => {
    const plan = buildEnterpriseProvisionPlan({
      rangeInstanceId: 'range-instance-cps',
      templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
      allocatedCidr: null,
      compiledProvisionSpec: {
        schemaVersion: '1.0.0',
        identity: {
          templateSlug: 'enterprise-template',
          templateVersion: 'v1',
          cloudProvider: 'alibaba_cloud',
          iacType: 'opentofu',
        },
        topology: {
          vpcCidr: '10.91.0.0/16',
          entryHostKey: 'dmz-entry',
        },
        networkZones: [
          { key: 'dmz', name: 'DMZ', cidr: '10.91.10.0/24', purpose: 'public-entry', isPublicEntry: true, routeRole: 'entry' },
          { key: 'office', name: 'Office', cidr: '10.91.20.0/24', purpose: 'user-workstations', isPublicEntry: false, routeRole: 'internal' },
          { key: 'server', name: 'Server', cidr: '10.91.30.0/24', purpose: 'application-servers', isPublicEntry: false, routeRole: 'internal' },
        ],
        hosts: [
          {
            key: 'dmz-entry',
            name: 'DMZ Entry',
            role: 'entry',
            zoneKey: 'dmz',
            primaryPrivateIp: '10.91.10.10',
            exposePublic: true,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'dmz', privateIp: '10.91.10.10' }],
          },
          {
            key: 'office-client',
            name: 'Office Client',
            role: 'workstation',
            zoneKey: 'office',
            primaryPrivateIp: '10.91.20.10',
            exposePublic: false,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'office', privateIp: '10.91.20.10' }],
          },
          {
            key: 'server-app',
            name: 'Server App',
            role: 'app',
            zoneKey: 'server',
            primaryPrivateIp: '10.91.30.10',
            exposePublic: false,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'server', privateIp: '10.91.30.10' }],
          },
        ],
        natGateways: [
          { key: 'nat-office', name: 'Office NAT', zoneKey: 'office' },
        ],
        eips: [
          { key: 'eip-entry', name: 'Entry EIP', bindTargetType: 'host', bindTargetKey: 'dmz-entry', bandwidthMbps: 30 },
        ],
        snatEntries: [
          { key: 'snat-office', zoneKey: 'office', natGatewayKey: 'nat-office', eipKey: 'eip-entry' },
        ],
        dnatEntries: [
          { key: 'dnat-server-http', hostKey: 'server-app', natGatewayKey: 'nat-office', eipKey: 'eip-entry', protocol: 'tcp', externalPort: 8080, internalPort: 80 },
        ],
        securityGroupRules: [],
        aclRules: [],
        bootstrapScripts: [],
        runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} },
      },
    });

    expect(plan.topologySummary).toEqual({
      vpcCidr: '10.91.0.0/16',
      publicEntryHostKey: 'dmz-entry',
      networkZoneKeys: ['dmz', 'office', 'server'],
      hostKeys: ['dmz-entry', 'office-client', 'server-app'],
    });
    expect(plan.hostDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'dmz-entry', privateIp: '10.91.10.10', exposePublic: true }),
        expect.objectContaining({ key: 'server-app', privateIp: '10.91.30.10', exposePublic: false }),
      ]),
    );
    expect(plan.snatEntries).toEqual([
      { key: 'snat-office', name: 'snat-office', natGatewayKey: 'nat-office', sourceZoneKey: 'office', eipKey: 'eip-entry' },
    ]);
    expect(plan.dnatEntries).toEqual([
      { key: 'dnat-server-http', name: 'dnat-server-http', natGatewayKey: 'nat-office', eipKey: 'eip-entry', backendHostKey: 'server-app', externalPort: 8080, internalPort: 80, protocol: 'tcp' },
    ]);
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

  it('builds a provision plan for generic single-zone multi-ecs topologies without requiring dmz office server aliases', () => {
    const plan = buildEnterpriseProvisionPlan({
      rangeInstanceId: 'range-instance-generic',
      templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
      allocatedCidr: null,
      topologySpec: {
        vpcCidr: '10.70.0.0/16',
        networkZones: [
          {
            key: 'zone-1',
            name: 'Zone-1',
            purpose: 'business-zone',
            cidr: '10.0.0.0/16',
            isPublicEntry: true,
          },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'ECS 1',
            zoneKey: 'zone-1',
            role: 'host',
            privateIp: '10.0.0.1',
            exposePublic: true,
          },
          {
            key: 'ecs-2',
            name: 'ECS 2',
            zoneKey: 'zone-1',
            role: 'host',
            privateIp: '10.0.0.2',
          },
          {
            key: 'ecs-3',
            name: 'ECS 3',
            zoneKey: 'zone-1',
            role: 'host',
            privateIp: '10.0.0.3',
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
          vpcCidr: '10.70.0.0/16',
          entryHostKey: 'ecs-1',
        },
        networkZones: [
          { key: 'zone-1', name: '交换机', cidr: '10.0.0.0/16', purpose: 'business-zone', isPublicEntry: true, routeRole: 'entry' },
        ],
        hosts: [
          {
            key: 'ecs-1',
            name: 'test-ubuntu',
            role: 'host',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.0.0.1',
            exposePublic: true,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'zone-1', privateIp: '10.0.0.1' }],
          },
          {
            key: 'ecs-2',
            name: 'test-ubuntu',
            role: 'host',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.0.0.2',
            exposePublic: false,
            networkInterfaces: [{ deviceIndex: 0, zoneKey: 'zone-1', privateIp: '10.0.0.2' }],
          },
        ],
        natGateways: [{ key: 'nat-switch-1', name: '交换机 NAT', zoneKey: 'zone-1' }],
        eips: [{ key: 'eip-switch-1', name: '交换机 EIP', bindTargetType: 'nat_gateway', bindTargetKey: 'nat-switch-1', bandwidthMbps: 30 }],
        snatEntries: [{ key: 'snat-zone-1', zoneKey: 'zone-1', natGatewayKey: 'nat-switch-1', eipKey: 'eip-switch-1' }],
        dnatEntries: [],
        securityGroupRules: [],
        aclRules: [],
        bootstrapScripts: [],
        runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} },
      },
    });

    expect(plan.topologySummary).toEqual({
      vpcCidr: '10.70.0.0/16',
      publicEntryHostKey: 'ecs-1',
      networkZoneKeys: ['zone-1'],
      hostKeys: ['ecs-1', 'ecs-2', 'ecs-3'],
    });
    expect(plan.network).toEqual({
      vpcCidr: '10.70.0.0/16',
      dmzCidr: '10.0.0.0/16',
      officeCidr: '10.0.0.0/16',
      serverCidr: '10.0.0.0/16',
    });
    expect(plan.hosts.publicEntry).toEqual(expect.objectContaining({ key: 'ecs-1', privateIp: '10.0.0.1' }));
    expect(plan.hosts.officePrimary).toEqual(expect.objectContaining({ key: 'ecs-2', privateIp: '10.0.0.2' }));
    expect(plan.hosts.serverPrimary).toEqual(expect.objectContaining({ key: 'ecs-3', privateIp: '10.0.0.3' }));
    expect(plan.natGateways).toEqual([
      { key: 'nat-switch-1', name: '交换机 NAT', zoneKey: 'zone-1', snatEnabled: true },
    ]);
    expect(plan.snatEntries).toEqual([
      { key: 'snat-zone-1', name: 'snat-zone-1', natGatewayKey: 'nat-switch-1', sourceZoneKey: 'zone-1', eipKey: 'eip-switch-1' },
    ]);
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
          {
            id: 'snat-office',
            type: 'snat_entry',
            provider: 'alibaba_cloud',
            config: {
              label: '办公网 SNAT',
              natGatewayKey: 'nat-office',
              sourceZoneKey: 'office',
              eipKey: 'eip-office-nat',
            },
          },
          {
            id: 'dnat-entry-web',
            type: 'dnat_entry',
            provider: 'alibaba_cloud',
            config: {
              label: 'Web DNAT',
              natGatewayKey: 'nat-office',
              eipKey: 'eip-office-nat',
              backendHostKey: 'host-server-app',
              externalPort: 8080,
              internalPort: 80,
              protocol: 'tcp',
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
    expect(plan.snatEntries).toEqual([
      {
        key: 'snat-office',
        name: '办公网 SNAT',
        natGatewayKey: 'nat-office',
        sourceZoneKey: 'office',
        eipKey: 'eip-office-nat',
      },
    ]);
    expect(plan.dnatEntries).toEqual([
      {
        key: 'dnat-entry-web',
        name: 'Web DNAT',
        natGatewayKey: 'nat-office',
        eipKey: 'eip-office-nat',
        backendHostKey: 'host-server-app',
        externalPort: 8080,
        internalPort: 80,
        protocol: 'tcp',
      },
    ]);
  });
});
