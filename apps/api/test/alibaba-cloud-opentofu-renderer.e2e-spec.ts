import { AlibabaCloudOpenTofuRenderer } from '../src/provisioning/renderers/alibaba-cloud-opentofu-renderer';

describe('AlibabaCloudOpenTofuRenderer', () => {
  it('renders enterprise provision plan into stable OpenTofu tfvars', () => {
    const renderer = new AlibabaCloudOpenTofuRenderer();

    const variables = renderer.render({
      plan: {
        resourceNamePrefix: 'range-demo',
        modulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
        entryHostKey: 'dmz-entry',
        topologySummary: {
          vpcCidr: '10.90.0.0/16',
          publicEntryHostKey: 'dmz-entry',
          networkZoneKeys: ['dmz', 'office', 'server'],
          hostKeys: ['dmz-entry', 'office-client', 'server-app'],
        },
        network: {
          vpcCidr: '10.90.0.0/16',
          dmzCidr: '10.90.10.0/24',
          officeCidr: '10.90.20.0/24',
          serverCidr: '10.90.30.0/24',
        },
        networkZones: [
          { key: 'dmz', name: 'DMZ', cidr: '10.90.10.0/24', purpose: 'public-entry', isPublicEntry: true },
          { key: 'office', name: 'Office', cidr: '10.90.20.0/24', purpose: 'user-workstations', isPublicEntry: false },
          { key: 'server', name: 'Server', cidr: '10.90.30.0/24', purpose: 'application-servers', isPublicEntry: false },
        ],
        hostDefinitions: [
          { key: 'dmz-entry', name: 'DMZ Entry', zoneKey: 'dmz', privateIp: '10.90.10.10', role: 'entry', exposePublic: true },
          { key: 'office-client', name: 'Office Client', zoneKey: 'office', privateIp: '10.90.20.10', role: 'workstation', exposePublic: false },
          { key: 'server-app', name: 'Server App', zoneKey: 'server', privateIp: '10.90.30.10', role: 'app', exposePublic: false },
        ],
        natGateways: [{ key: 'nat-office', name: 'Office NAT', zoneKey: 'office', snatEnabled: true }],
        eipDefinitions: [{ key: 'eip-entry', name: 'Entry EIP', bindTargetType: 'host', bindTargetKey: 'dmz-entry', bandwidthMbps: 30 }],
        securityGroupRules: [{ key: 'sg-entry-ssh', name: 'Entry SSH', targetHostKey: 'dmz-entry', direction: 'ingress', policy: 'accept', protocol: 'tcp', portRange: '22/22', sourceCidr: '0.0.0.0/0', priority: 1 }],
        aclDefinitions: [{ key: 'acl-office', name: 'Office ACL', zoneKey: 'office', direction: 'inbound', policy: 'accept', protocol: 'tcp', portRange: '3389/3389', sourceCidr: '10.0.0.0/8', priority: 10 }],
        snatEntries: [{ key: 'snat-office', name: 'Office SNAT', natGatewayKey: 'nat-office', sourceZoneKey: 'office', eipKey: 'eip-entry' }],
        dnatEntries: [{ key: 'dnat-web', name: 'Web DNAT', natGatewayKey: 'nat-office', eipKey: 'eip-entry', backendHostKey: 'server-app', externalPort: 8080, internalPort: 80, protocol: 'tcp' }],
        hostNetworkInterfaces: [
          {
            hostKey: 'server-app',
            interfaces: [
              { deviceIndex: 0, zoneKey: 'server', privateIp: '10.90.30.10' },
              { deviceIndex: 1, zoneKey: 'office', privateIp: '10.90.20.30', description: 'pivot' },
            ],
          },
        ],
        bootstrapScripts: [
          {
            key: 'server-bootstrap',
            name: 'Server Bootstrap',
            type: 'shell',
            content: '#!/bin/bash\necho ready',
            targetHostKeys: ['server-app'],
          },
        ],
        runtimeSelections: {
          imagePolicies: {
            'server-image': { mode: 'fixed', imageId: 'custom-image' },
          },
          instanceTypePolicies: {
            'server-instance': { mode: 'prefer-list', preferredInstanceTypes: ['ecs.c7.large'] },
          },
        },
        hosts: {
          publicEntry: { key: 'dmz-entry', name: 'DMZ Entry', zoneKey: 'dmz', role: 'entry', privateIp: '10.90.10.10', exposePublic: true },
          officePrimary: { key: 'office-client', name: 'Office Client', zoneKey: 'office', role: 'workstation', privateIp: '10.90.20.10' },
          serverPrimary: { key: 'server-app', name: 'Server App', zoneKey: 'server', role: 'app', privateIp: '10.90.30.10' },
        },
      },
      rangeInstanceId: 'range-instance-1',
      zoneId: 'cn-hangzhou-h',
      attemptedZones: [
        {
          zoneId: 'cn-hangzhou-h',
          canCreateAllHosts: false,
          estimatedTotalPrice: null,
          reason: 'default zone lacks one required host shape',
        },
        {
          zoneId: 'cn-hangzhou-i',
          canCreateAllHosts: true,
          estimatedTotalPrice: 7.25,
        },
      ],
      instanceType: 'ecs.e-c1m1.large',
      hostInstanceTypes: {
        'dmz-entry': 'ecs.e-c1m1.large',
        'office-client': 'ecs.c7.large',
        'server-app': 'ecs.c7.large',
      },
      imageId: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
      hostPasswords: {
        'dmz-entry': 'ChangeMe123!',
        'office-client': 'ChangeMe123!',
        'server-app': 'ChangeMe123!',
      },
      instancePassword: 'ChangeMe123!',
      allowedIngressCidr: '0.0.0.0/0',
      internetMaxBandwidthOut: 50,
      systemDiskCategory: 'cloud_essd',
      systemDiskSize: 40,
    });

    expect(variables).not.toHaveProperty('selected_zone_id');
    expect(variables).not.toHaveProperty('attempted_zones');
    expect(variables).toEqual(
      expect.objectContaining({
        resource_name_prefix: 'range-demo',
        zone_id: 'cn-hangzhou-h',
        vpc_cidr: '10.90.0.0/16',
        entry_host_key: 'dmz-entry',
        instance_type: 'ecs.e-c1m1.large',
        image_id: 'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
        system_disk_category: 'cloud_essd',
        system_disk_size: 40,
        internet_max_bandwidth_out: 50,
        host_network_interfaces: [
          expect.objectContaining({
            host_key: 'server-app',
            interfaces: expect.arrayContaining([
              expect.objectContaining({ device_index: 1, zone_key: 'office', private_ip: '10.90.20.30' }),
            ]),
          }),
        ],
        hosts: expect.arrayContaining([
          expect.objectContaining({ key: 'dmz-entry', instance_type: 'ecs.e-c1m1.large' }),
          expect.objectContaining({ key: 'server-app', instance_type: 'ecs.c7.large' }),
        ]),
        bootstrap_scripts: [
          expect.objectContaining({ key: 'server-bootstrap', target_host_keys: ['server-app'] }),
        ],
        runtime_selections: expect.objectContaining({
          attempted_zones: [
            {
              zone_id: 'cn-hangzhou-h',
              can_create_all_hosts: false,
              estimated_total_price: null,
              reason: 'default zone lacks one required host shape',
            },
            {
              zone_id: 'cn-hangzhou-i',
              can_create_all_hosts: true,
              estimated_total_price: 7.25,
            },
          ],
          image_policies: expect.objectContaining({
            'server-image': expect.objectContaining({ imageId: 'custom-image' }),
          }),
          instance_type_policies: expect.objectContaining({
            'server-instance': expect.objectContaining({ preferredInstanceTypes: ['ecs.c7.large'] }),
          }),
        }),
        snat_entries: [
          expect.objectContaining({ key: 'snat-office', source_zone_key: 'office' }),
        ],
        dnat_entries: [
          expect.objectContaining({ key: 'dnat-web', backend_host_key: 'server-app', external_port: 8080 }),
        ],
        tags: { range_instance_id: 'range-instance-1' },
      }),
    );
  });
});
