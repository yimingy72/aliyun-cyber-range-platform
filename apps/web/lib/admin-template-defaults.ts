import type { RangeTemplateTopologySpec } from './admin-types';

export const DEFAULT_TEMPLATE_MODULE_PATH = 'infra/opentofu/modules/alicloud-enterprise-range';

export function createDefaultEnterpriseTopologySpec(): RangeTemplateTopologySpec {
  return {
    vpcCidr: '10.70.0.0/16',
    networkZones: [
      {
        key: 'dmz',
        name: 'DMZ',
        purpose: 'public-entry',
        cidr: '10.70.10.0/24',
        isPublicEntry: true,
      },
      {
        key: 'office',
        name: 'Office',
        purpose: 'user-workstations',
        cidr: '10.70.20.0/24',
      },
      {
        key: 'server',
        name: 'Server',
        purpose: 'application-servers',
        cidr: '10.70.30.0/24',
      },
    ],
    hosts: [
      {
        key: 'dmz-entry',
        name: 'DMZ Entry',
        zoneKey: 'dmz',
        role: 'entry',
        privateIp: '10.70.10.10',
        exposePublic: true,
      },
      {
        key: 'office-client',
        name: 'Office Client',
        zoneKey: 'office',
        role: 'workstation',
        privateIp: '10.70.20.10',
      },
      {
        key: 'server-app',
        name: 'Server App',
        zoneKey: 'server',
        role: 'app',
        privateIp: '10.70.30.10',
      },
    ],
    publicEntry: {
      hostKey: 'dmz-entry',
      protocols: [
        { protocol: 'ssh', port: 22 },
        { protocol: 'http', port: 80 },
      ],
    },
    executionPolicies: {
      allowSshIngress: true,
      allowHttpIngress: true,
      enableSnatOnDemand: false,
    },
  };
}
