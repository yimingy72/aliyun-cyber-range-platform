import { describe, expect, it } from 'vitest';

import { createEnterpriseRangeSkeleton } from './template-topology-skeleton';
import { syncTopologySpecFromNodes } from './template-topology-sync';

describe('syncTopologySpecFromNodes', () => {
  it('builds a formal topologySpec from the enterprise skeleton nodes', () => {
    const topologySpec = syncTopologySpecFromNodes({
      nodes: createEnterpriseRangeSkeleton(),
    });

    expect(topologySpec.vpcCidr).toBe('10.70.0.0/16');
    expect(topologySpec.networkZones).toEqual([
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
    ]);
    expect(topologySpec.hosts).toEqual([
      {
        key: 'host-dmz-entry',
        name: 'DMZ 入口主机',
        zoneKey: 'dmz',
        role: 'entry',
        privateIp: '10.70.10.10',
        exposePublic: true,
      },
      {
        key: 'host-office-client',
        name: '办公网主机',
        zoneKey: 'office',
        role: 'workstation',
        privateIp: '10.70.20.10',
        exposePublic: false,
      },
      {
        key: 'host-server-db',
        name: '数据库主机',
        zoneKey: 'server',
        role: 'db',
        privateIp: '10.70.30.20',
        exposePublic: false,
      },
    ]);
    expect(topologySpec.publicEntry).toEqual({
      hostKey: 'host-dmz-entry',
      protocols: [
        { protocol: 'ssh', port: 22 },
        { protocol: 'http', port: 80 },
      ],
    });
  });
});
