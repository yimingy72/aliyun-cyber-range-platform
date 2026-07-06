import type { RangeTemplateTopologySpec } from './admin-types';

export const DEFAULT_TEMPLATE_MODULE_PATH = 'infra/opentofu/modules/alicloud-enterprise-range';

export function createDefaultEnterpriseTopologySpec(): RangeTemplateTopologySpec {
  return {
    vpcCidr: '10.0.0.0/16',
    networkZones: [
      {
        key: 'core',
        name: 'Core Switch',
        purpose: 'business-zone',
        cidr: '10.0.0.0/24',
        isPublicEntry: true,
      },
    ],
    hosts: [
      {
        key: 'ecs-core-1',
        name: '业务 ECS',
        zoneKey: 'core',
        role: 'entry',
        privateIp: '10.0.0.10',
        exposePublic: true,
      },
    ],
    publicEntry: {
      hostKey: 'ecs-core-1',
      protocols: [
        { protocol: 'ssh', port: 22 },
        { protocol: 'http', port: 80 },
      ],
    },
    executionPolicies: {
      allowSshIngress: true,
      allowHttpIngress: true,
      enableRouterEgress: true,
    },
  };
}
