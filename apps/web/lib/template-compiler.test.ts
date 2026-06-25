import { describe, expect, it } from 'vitest';

import { compileTopologyGraph } from './template-compiler';
import type { RangeTemplateTopologySpec } from './admin-types';
import type { TemplateNode } from '../components/admin/template-editor/template-property-panel';

describe('compileTopologyGraph', () => {
  it('compiles host, switch, router, nat, eip, acl, and security group rule nodes with stable resource shapes', () => {
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
      {
        id: 'nat-1',
        kind: 'nat_gateway',
        label: '办公区 NAT',
        zoneKey: 'dmz-a',
        snatEnabled: true,
      },
      {
        id: 'eip-1',
        kind: 'eip',
        label: 'DMZ 入口 EIP',
        bindTargetType: 'host',
        bindTargetKey: 'host-1',
        bandwidthMbps: 20,
      },
      {
        id: 'acl-1',
        kind: 'acl',
        label: 'DMZ ACL',
        zoneKey: 'dmz-a',
        direction: 'inbound',
        policy: 'allow',
        protocol: 'tcp',
        portRange: '22/22',
        sourceCidr: '0.0.0.0/0',
        priority: 1,
      },
      {
        id: 'sg-rule-1',
        kind: 'security_group_rule',
        label: '入口主机 SSH 放行',
        targetHostKey: 'host-1',
        direction: 'ingress',
        policy: 'accept',
        protocol: 'tcp',
        portRange: '22/22',
        sourceCidr: '0.0.0.0/0',
        priority: 1,
      },
    ];

    const topologySpec: RangeTemplateTopologySpec = {
      vpcCidr: '10.70.0.0/16',
      networkZones: [
        {
          key: 'dmz-a',
          name: 'DMZ',
          purpose: 'dmz',
          cidr: '10.0.1.0/24',
          isPublicEntry: true,
        },
      ],
      hosts: [
        {
          key: 'host-1',
          name: '边界主机',
          zoneKey: 'dmz-a',
          role: 'entry',
          privateIp: '10.0.1.10',
          exposePublic: true,
        },
      ],
      publicEntry: {
        hostKey: 'host-1',
        protocols: [{ protocol: 'ssh', port: 22 }],
      },
    };

    expect(compileTopologyGraph({ nodes, topologySpec })).toEqual({
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
        {
          id: 'nat-1',
          type: 'nat_gateway',
          provider: 'alibaba_cloud',
          config: {
            label: '办公区 NAT',
            zoneKey: 'dmz-a',
            snatEnabled: true,
          },
        },
        {
          id: 'eip-1',
          type: 'eip',
          provider: 'alibaba_cloud',
          config: {
            label: 'DMZ 入口 EIP',
            bindTargetType: 'host',
            bindTargetKey: 'host-1',
            bandwidthMbps: 20,
          },
        },
        {
          id: 'acl-1',
          type: 'acl',
          provider: 'alibaba_cloud',
          config: {
            label: 'DMZ ACL',
            zoneKey: 'dmz-a',
            direction: 'inbound',
            policy: 'allow',
            protocol: 'tcp',
            portRange: '22/22',
            sourceCidr: '0.0.0.0/0',
            priority: 1,
          },
        },
        {
          id: 'sg-rule-1',
          type: 'security_group_rule',
          provider: 'alibaba_cloud',
          config: {
            label: '入口主机 SSH 放行',
            targetHostKey: 'host-1',
            direction: 'ingress',
            policy: 'accept',
            protocol: 'tcp',
            portRange: '22/22',
            sourceCidr: '0.0.0.0/0',
            priority: 1,
          },
        },
      ],
      topology: {
        vpcCidr: '10.70.0.0/16',
        publicEntryHostKey: 'host-1',
        networkZoneKeys: ['dmz-a'],
        hostKeys: ['host-1'],
      },
    });

    expect(Object.keys(compileTopologyGraph({ nodes, topologySpec }).resources[1]?.config ?? {}).sort()).toEqual([
      'cidr',
      'enableNat',
      'label',
      'purpose',
      'zoneKey',
    ]);
    expect(Object.keys(compileTopologyGraph({ nodes, topologySpec }).resources[2]?.config ?? {}).sort()).toEqual([
      'bindEip',
      'egressType',
      'label',
      'routeRole',
    ]);
    expect(Object.keys(compileTopologyGraph({ nodes, topologySpec }).resources[3]?.config ?? {}).sort()).toEqual([
      'label',
      'snatEnabled',
      'zoneKey',
    ]);
    expect(Object.keys(compileTopologyGraph({ nodes, topologySpec }).resources[4]?.config ?? {}).sort()).toEqual([
      'bandwidthMbps',
      'bindTargetKey',
      'bindTargetType',
      'label',
    ]);
  });

  it('throws for unsupported node kinds instead of compiling undefined config', () => {
    const invalidNode = {
      id: 'unknown-1',
      kind: 'firewall',
      label: '未知节点',
    } as TemplateNode;

    expect(() => compileTopologyGraph({ nodes: [invalidNode], topologySpec: null })).toThrowError(
      'Unsupported template node kind: firewall',
    );
  });
});
