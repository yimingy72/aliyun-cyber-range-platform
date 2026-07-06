// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TemplatePropertyPanel, type TemplateNode } from './template-property-panel';

afterEach(() => {
  cleanup();
});

describe('TemplatePropertyPanel', () => {
  it('renders the ECS init section with a single 初始化脚本 title', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'switch-1',
        kind: 'switch',
        label: '交换机 1',
        position: { x: 360, y: 180 },
        zoneKey: 'core',
        cidr: '10.0.0.0/16',
        purpose: 'business-zone',
        description: '',
        aclRules: [],
        nat: {
          snatEnabled: false,
          dnatMappings: [],
        },
      },
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: 'ECS 1',
        position: { x: 620, y: 180 },
        instanceName: 'ECS 1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'host',
        privateIp: '',
        exposePublic: false,
        image: 'ubuntu_22_04_x64_20G_alibase',
        imageName: 'ubuntu_22_04_x64_20G_alibase',
        imageId: 'ubuntu_22_04_x64_20G_alibase',
        cpu: 1,
        memory: 2,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: 'switch-1',
            privateIp: '',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplatePropertyPanel
        selectedNode={nodes[1] ?? null}
        allNodes={nodes}
        linkedSwitchIdsByHostId={{ 'ecs-1': ['switch-1'] }}
        platformImageAssets={[]}
        onUpdateNode={vi.fn()}
      />,
    );

    expect(screen.getAllByText('初始化脚本')).toHaveLength(1);
    expect(screen.queryByText('初始化')).toBeNull();
    expect(screen.queryByText('节点配置')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存属性' })).toBeNull();
  });

  it('shows the compact ecs basic-info fields in the requested order', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: 'ECS 1',
        position: { x: 620, y: 180 },
        instanceName: 'ECS 1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'host',
        privateIp: '',
        exposePublic: false,
        image: 'ubuntu_22_04_x64_20G_alibase',
        imageName: 'ubuntu_22_04_x64_20G_alibase',
        imageId: 'ubuntu_22_04_x64_20G_alibase',
        cpu: 1,
        memory: 2,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: '',
            privateIp: '',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    render(
      <TemplatePropertyPanel
        selectedNode={nodes[0] ?? null}
        allNodes={nodes}
        linkedSwitchIdsByHostId={{}}
        platformImageAssets={[]}
        onUpdateNode={vi.fn()}
      />,
    );

    const basicGroup = screen.getByText('基础信息').closest('.template-property-group');
    const labels = Array.from(basicGroup?.querySelectorAll('.template-property-field-label') ?? []).map((node) =>
      node.textContent?.trim(),
    );

    expect(labels).toEqual(['名称', '主机名', '镜像名', 'CPU', '内存']);
    expect(screen.getByText('ECS')).toBeTruthy();
    expect(screen.queryByLabelText('启动等待时间')).toBeNull();
  });

  it('renders switch cidr editing without the old device-type row or subnet label', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'switch-1',
        kind: 'switch',
        label: '交换机 1',
        position: { x: 360, y: 180 },
        zoneKey: 'core',
        cidr: '10.10.10.0/24',
        purpose: 'business-zone',
        description: '',
        aclRules: [],
        nat: {
          snatEnabled: false,
          dnatMappings: [],
        },
      },
    ];

    render(
      <TemplatePropertyPanel
        selectedNode={nodes[0] ?? null}
        allNodes={nodes}
        linkedSwitchIdsByHostId={{}}
        platformImageAssets={[]}
        onUpdateNode={vi.fn()}
      />,
    );

    expect(screen.queryByText('设备类型')).toBeNull();
    expect(screen.queryByText(/^网段$/)).toBeNull();
    expect(screen.queryByLabelText('CIDR 第一段')).toBeTruthy();
    expect(screen.queryByLabelText('CIDR 第二段')).toBeTruthy();
    expect(screen.queryByLabelText('CIDR 第三段')).toBeTruthy();
    expect(screen.queryByLabelText('CIDR 第四段')).toBeTruthy();
    expect(screen.queryByLabelText('CIDR 前缀')).toBeTruthy();
  });

  it('renders platform image selection for ecs nodes and updates image fields together', () => {
    const onUpdateNode = vi.fn();
    const nodes: TemplateNode[] = [
      {
        id: 'ecs-1',
        kind: 'ecs',
        label: 'ECS 1',
        position: { x: 620, y: 180 },
        instanceName: 'ECS 1',
        hostName: 'ecs-1',
        zoneKey: 'core',
        role: 'host',
        privateIp: '',
        exposePublic: false,
        image: 'ubuntu_22_04_x64_20G_alibase',
        imageName: 'Ubuntu 22.04',
        imageId: 'ubuntu_22_04_x64_20G_alibase',
        cpu: 1,
        memory: 2,
        description: '',
        bootPriority: 1,
        bootWaitSeconds: 0,
        dnatMappings: [],
        networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
        portGroups: [],
        nics: [
          {
            id: 'ecs-1-nic-1',
            switchId: '',
            privateIp: '',
            secondaryIps: [],
            securityGroupRules: [],
          },
        ],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'fixed', instanceType: 'ecs.u1-c1m2.large' },
      },
    ];

    render(
      <TemplatePropertyPanel
        selectedNode={nodes[0] ?? null}
        allNodes={nodes}
        linkedSwitchIdsByHostId={{}}
        platformImageAssets={[
          {
            id: 'platform-image-1',
            displayName: 'Ubuntu 24.04 LTS',
            imageId: 'ubuntu_24_04_x64_20G_alibase',
            provider: 'alibaba_cloud',
            accountUid: null,
            accountScopeKey: 'public:cn-hangzhou',
            regionId: 'cn-hangzhou',
            sourceScope: 'public',
            enabled: true,
            sourceSnapshotId: 'snapshot-1',
            createdAt: '2026-07-03T00:00:00.000Z',
            updatedAt: '2026-07-03T00:00:00.000Z',
          },
        ]}
        onUpdateNode={onUpdateNode}
      />,
    );

    fireEvent.change(screen.getByLabelText('镜像名'), {
      target: { value: 'Ubuntu 24.04 LTS' },
    });
    fireEvent.keyDown(screen.getByLabelText('镜像名'), { key: 'Enter' });

    expect(onUpdateNode).toHaveBeenCalledWith(
      'ecs-1',
      expect.objectContaining({
        platformImageAssetId: 'platform-image-1',
        image: 'Ubuntu 24.04 LTS',
        imageName: 'Ubuntu 24.04 LTS',
        imageId: 'ubuntu_24_04_x64_20G_alibase',
        imageStrategy: {
          mode: 'fixed',
          imageId: 'ubuntu_24_04_x64_20G_alibase',
        },
      }),
    );
  });
});
