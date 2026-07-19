import { describe, expect, it } from 'vitest';

import { findDuplicateDnatExternalPorts, PHASE_ONE_NODE_KINDS, isPhaseOneNodeKind } from './scenario-graph';

describe('scenario-graph phase-one kinds', () => {
  it('exposes only router, switch, and ecs as first-class phase-one node kinds', () => {
    expect(PHASE_ONE_NODE_KINDS).toEqual(['router', 'switch', 'ecs']);
  });

  it('accepts only phase-one node kinds', () => {
    expect(isPhaseOneNodeKind('router')).toBe(true);
    expect(isPhaseOneNodeKind('switch')).toBe(true);
    expect(isPhaseOneNodeKind('ecs')).toBe(true);
    expect(isPhaseOneNodeKind('nat_gateway')).toBe(false);
    expect(isPhaseOneNodeKind('eip')).toBe(false);
    expect(isPhaseOneNodeKind('acl')).toBe(false);
    expect(isPhaseOneNodeKind('security_group_rule')).toBe(false);
    expect(isPhaseOneNodeKind('snat_entry')).toBe(false);
    expect(isPhaseOneNodeKind('dnat_entry')).toBe(false);
  });

  it('finds duplicate DNAT external ports across different switches', () => {
    const conflicts = findDuplicateDnatExternalPorts([
      {
        id: 'switch-1',
        kind: 'switch',
        label: '交换机 1',
        zoneKey: 'zone-1',
        cidr: '10.0.0.0/24',
        purpose: 'dmz',
        nat: {
          snatEnabled: true,
          dnatMappings: [{ key: 'switch-1-dnat-1', targetHostId: 'ecs-1', externalPort: 22, internalPort: 22, protocol: 'tcp' }],
        },
      },
      {
        id: 'switch-2',
        kind: 'switch',
        label: '交换机 2',
        zoneKey: 'zone-2',
        cidr: '192.168.0.0/24',
        purpose: 'internal',
        nat: {
          snatEnabled: false,
          dnatMappings: [{ key: 'switch-2-dnat-1', targetHostId: 'ecs-2', externalPort: 22, internalPort: 22, protocol: 'tcp' }],
        },
      },
    ]);

    expect(conflicts).toEqual([
      {
        externalPort: 22,
        usages: [
          expect.objectContaining({ switchId: 'switch-1', mappingKey: 'switch-1-dnat-1' }),
          expect.objectContaining({ switchId: 'switch-2', mappingKey: 'switch-2-dnat-1' }),
        ],
      },
    ]);
  });
});
