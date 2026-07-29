import type { ScenarioGraphEdge, TemplateNode } from './scenario-graph';

export function createEnterpriseRangeSkeleton(): TemplateNode[] {
  return [
    {
      id: 'router-core',
      kind: 'router',
      label: '主路由器',
      position: { x: 120, y: 220 },
      description: '单 VPC 根节点',
      routeRole: 'core',
      egressType: 'internet',
      bindEip: false,
    },
    {
      id: 'switch-core',
      kind: 'switch',
      label: '业务交换机',
      position: { x: 360, y: 220 },
      zoneKey: 'core',
      cidr: '10.0.0.0/24',
      purpose: 'business-zone',
      description: '默认业务网段',
      aclRules: [],
      nat: {
        snatEnabled: false,
        dnatMappings: [
          {
            key: 'switch-core-dnat-entry',
            targetHostId: 'ecs-core-1',
            externalPort: 80,
            internalPort: 80,
            protocol: 'tcp',
          },
        ],
      },
    },
    {
      id: 'ecs-core-1',
      kind: 'ecs',
      label: '业务 ECS',
      position: { x: 620, y: 220 },
      instanceName: 'ecs-core-1',
      hostName: 'core-entry',
      zoneKey: 'core',
      role: 'host',
      privateIp: '10.0.0.10',
      exposePublic: false,
      image: 'aliyun_linux_3_x64_20G_alibase',
      imageName: 'aliyun_linux_3_x64_20G_alibase',
      imageId: 'aliyun_linux_3_x64_20G_alibase',
      cpu: 2,
      memory: 4,
      description: '默认入口主机',
      bootPriority: 1,
      bootWaitSeconds: 0,
      dnatMappings: [],
      networkInterfaces: [{ zoneKey: 'core', privateIp: '10.0.0.10' }],
      portGroups: [],
      nics: [
        {
          id: 'nic-core-1',
          switchId: 'switch-core',
          privateIp: '10.0.0.10',
          secondaryIps: [],
          securityGroupRules: [],
        },
      ],
      initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
      instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
    },
  ];
}

export function createEnterpriseRangeSkeletonEdges(): ScenarioGraphEdge[] {
  return [
    {
      id: 'edge-router-core-switch-core',
      fromNodeId: 'router-core',
      toNodeId: 'switch-core',
      relationType: 'manual',
      label: '主路由器 -> 业务交换机',
    },
    {
      id: 'edge-switch-core-ecs-core-1',
      fromNodeId: 'switch-core',
      toNodeId: 'ecs-core-1',
      relationType: 'manual',
      label: '业务交换机 -> 业务 ECS',
    },
  ];
}
