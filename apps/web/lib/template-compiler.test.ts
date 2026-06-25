import { describe, expect, it } from 'vitest';

import { compileTopologyGraph } from './template-compiler';
import type { TemplateNode } from '../components/admin/template-editor/template-property-panel';

describe('compileTopologyGraph', () => {
  it('compiles host, switch, and router nodes with stable resource shapes', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'host-1',
        kind: 'host',
        label: '边界主机',
        zoneKey: 'dmz-a',
        role: 'entry',
        privateIp: '10.0.1.10',
        exposePublic: true,
        image: 'aliyun_linux_3_x64_20G_alibase',
      },
      {
        id: 'switch-1',
        kind: 'switch',
        label: 'DMZ 子网',
        zoneKey: 'dmz-a',
        cidr: '10.0.1.0/24',
        purpose: 'dmz',
        enableNat: true,
      },
      {
        id: 'router-1',
        kind: 'router',
        label: '公网出口',
        routeRole: 'egress',
        egressType: 'internet',
        bindEip: true,
      },
    ];

    expect(compileTopologyGraph({ nodes })).toEqual({
      schemaVersion: '1.0.0',
      resources: [
        {
          id: 'host-1',
          type: 'host',
          provider: 'alibaba_cloud',
          config: {
            label: '边界主机',
            zoneKey: 'dmz-a',
            role: 'entry',
            privateIp: '10.0.1.10',
            exposePublic: true,
            image: 'aliyun_linux_3_x64_20G_alibase',
          },
        },
        {
          id: 'switch-1',
          type: 'switch',
          provider: 'alibaba_cloud',
          config: {
            label: 'DMZ 子网',
            zoneKey: 'dmz-a',
            cidr: '10.0.1.0/24',
            purpose: 'dmz',
            enableNat: true,
          },
        },
        {
          id: 'router-1',
          type: 'router',
          provider: 'alibaba_cloud',
          config: {
            label: '公网出口',
            routeRole: 'egress',
            egressType: 'internet',
            bindEip: true,
          },
        },
      ],
    });

    expect(Object.keys(compileTopologyGraph({ nodes }).resources[1]?.config ?? {}).sort()).toEqual([
      'cidr',
      'enableNat',
      'label',
      'purpose',
      'zoneKey',
    ]);
    expect(Object.keys(compileTopologyGraph({ nodes }).resources[2]?.config ?? {}).sort()).toEqual([
      'bindEip',
      'egressType',
      'label',
      'routeRole',
    ]);
  });

  it('throws for unsupported node kinds instead of compiling undefined config', () => {
    const invalidNode = {
      id: 'unknown-1',
      kind: 'firewall',
      label: '未知节点',
    } as TemplateNode;

    expect(() => compileTopologyGraph({ nodes: [invalidNode] })).toThrowError(
      'Unsupported template node kind: firewall',
    );
  });
});
