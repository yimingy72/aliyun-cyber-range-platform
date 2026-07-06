import { describe, expect, it } from 'vitest';

import { PHASE_ONE_NODE_KINDS, isPhaseOneNodeKind } from './scenario-graph';

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
});
