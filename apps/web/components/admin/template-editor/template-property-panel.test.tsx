// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TemplatePropertyPanel, type TemplateNode } from './template-property-panel';

afterEach(() => {
  cleanup();
});

function createEcsNodeWithPlatformDefaults(): TemplateNode {
  return {
    id: 'ecs-1',
    kind: 'ecs',
    label: 'ECS 1',
    instanceName: 'ECS 1',
    hostName: 'ecs-1',
    zoneKey: 'core',
    role: 'host',
    privateIp: '10.0.0.10',
    exposePublic: true,
    image: 'ubuntu_22_04_x64_20G_alibase',
    imageName: 'ubuntu_22_04_x64_20G_alibase',
    imageId: 'ubuntu_22_04_x64_20G_alibase',
    cpu: 1,
    memory: 2,
    dnatMappings: [],
    networkInterfaces: [{ zoneKey: 'core', privateIp: '10.0.0.10' }],
    portGroups: [],
    nics: [
      {
        id: 'ecs-1-nic-1',
        switchId: 'switch-1',
        privateIp: '10.0.0.10',
        secondaryIps: [],
        securityGroupRules: [],
      },
    ],
    initScript: '',
    imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
    instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
  };
}

describe('TemplatePropertyPanel', () => {
  it('shows the platform default SSH and HTTP rules without a status label', () => {
    const node: TemplateNode = {
      id: 'ecs-1',
      kind: 'ecs',
      label: 'ECS 1',
      instanceName: 'ECS 1',
      hostName: 'ecs-1',
      zoneKey: 'core',
      role: 'host',
      privateIp: '10.0.0.10',
      exposePublic: true,
      image: 'ubuntu_22_04_x64_20G_alibase',
      imageName: 'ubuntu_22_04_x64_20G_alibase',
      imageId: 'ubuntu_22_04_x64_20G_alibase',
      cpu: 1,
      memory: 2,
      dnatMappings: [],
      networkInterfaces: [{ zoneKey: 'core', privateIp: '10.0.0.10' }],
      portGroups: [],
      nics: [
        {
          id: 'ecs-1-nic-1',
          switchId: 'switch-1',
          privateIp: '10.0.0.10',
          secondaryIps: [],
          securityGroupRules: [],
        },
      ],
      initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
      instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
    };

    render(<TemplatePropertyPanel selectedNode={node} allNodes={[node]} onUpdateNode={vi.fn()} />);

    expect(screen.queryByText('平台默认')).toBeNull();
    expect((screen.getByLabelText('安全协议 1-1') as HTMLSelectElement).value).toBe('tcp');
    expect((screen.getByLabelText('安全端口 1-1') as HTMLInputElement).value).toBe('22/22');
    expect((screen.getByLabelText('安全协议 1-2') as HTMLSelectElement).value).toBe('tcp');
    expect((screen.getByLabelText('安全端口 1-2') as HTMLInputElement).value).toBe('80/80');
    expect(screen.getAllByDisplayValue('0.0.0.0/0')).toHaveLength(2);
  });

  it('uses an unnumbered action label when adding a security rule', () => {
    const node = createEcsNodeWithPlatformDefaults();

    render(<TemplatePropertyPanel selectedNode={node} allNodes={[node]} onUpdateNode={vi.fn()} />);

    expect(screen.getByRole('button', { name: '添加安全规则' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '添加安全规则 1' })).toBeNull();
  });

  it('groups security rule cards inside the network-field inset', () => {
    const node = createEcsNodeWithPlatformDefaults();

    render(<TemplatePropertyPanel selectedNode={node} allNodes={[node]} onUpdateNode={vi.fn()} />);

    const securityRuleCard = screen.getByLabelText('安全协议 1-1').closest('.template-property-card');
    expect(securityRuleCard?.parentElement?.className).toContain('template-property-card-sub-list');
  });

  it('persists the remaining rules as custom when a platform default rule is deleted', () => {
    const node: TemplateNode = {
      id: 'ecs-1',
      kind: 'ecs',
      label: 'ECS 1',
      instanceName: 'ECS 1',
      hostName: 'ecs-1',
      zoneKey: 'core',
      role: 'host',
      privateIp: '10.0.0.10',
      exposePublic: true,
      image: 'ubuntu_22_04_x64_20G_alibase',
      imageName: 'ubuntu_22_04_x64_20G_alibase',
      imageId: 'ubuntu_22_04_x64_20G_alibase',
      cpu: 1,
      memory: 2,
      dnatMappings: [],
      networkInterfaces: [{ zoneKey: 'core', privateIp: '10.0.0.10' }],
      portGroups: [],
      nics: [
        {
          id: 'ecs-1-nic-1',
          switchId: 'switch-1',
          privateIp: '10.0.0.10',
          secondaryIps: [],
          securityGroupRules: [],
        },
      ],
      initScript: '',
      imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
      instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
    };
    const onUpdateNode = vi.fn();

    render(<TemplatePropertyPanel selectedNode={node} allNodes={[node]} onUpdateNode={onUpdateNode} />);
    fireEvent.click(screen.getByRole('button', { name: '删除安全规则 1-1' }));

    expect(onUpdateNode).toHaveBeenCalledWith(
      'ecs-1',
      expect.objectContaining({
        nics: [
          expect.objectContaining({
            securityGroupRulesMode: 'custom',
            securityGroupRules: [expect.objectContaining({ portRange: '80/80' })],
          }),
        ],
      }),
    );
  });

  it('persists edited platform default rules as custom', () => {
    const node = createEcsNodeWithPlatformDefaults();
    const onUpdateNode = vi.fn();

    render(<TemplatePropertyPanel selectedNode={node} allNodes={[node]} onUpdateNode={onUpdateNode} />);
    fireEvent.change(screen.getByLabelText('安全端口 1-1'), { target: { value: '2222/2222' } });

    expect(onUpdateNode).toHaveBeenCalledWith(
      'ecs-1',
      expect.objectContaining({
        nics: [
          expect.objectContaining({
            securityGroupRulesMode: 'custom',
            securityGroupRules: [
              expect.objectContaining({ portRange: '2222/2222' }),
              expect.objectContaining({ portRange: '80/80' }),
            ],
          }),
        ],
      }),
    );
  });

  it('marks duplicate DNAT external ports across switches as invalid', () => {
    const nodes: TemplateNode[] = [
      {
        id: 'switch-1',
        kind: 'switch',
        label: '交换机 1',
        zoneKey: 'zone-1',
        cidr: '10.0.0.0/24',
        purpose: 'dmz',
        aclRules: [],
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
        aclRules: [],
        nat: {
          snatEnabled: false,
          dnatMappings: [{ key: 'switch-2-dnat-1', targetHostId: 'ecs-2', externalPort: 22, internalPort: 22, protocol: 'tcp' }],
        },
      },
    ];

    render(
      <TemplatePropertyPanel
        selectedNode={nodes[0] ?? null}
        allNodes={nodes}
        onUpdateNode={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('DNAT 公网端口 1').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/当前拓扑共享 DNAT IP，公网端口必须唯一/)).toBeTruthy();
  });

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

    expect(labels).toEqual(['名称', '主机名', '镜像名', 'CPU', '内存', '自定义密码']);
    expect(screen.getByText('ECS')).toBeTruthy();
    expect(screen.queryByLabelText('启动等待时间')).toBeNull();
  });

  it('renders custom password as visible text without a visibility toggle', () => {
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

    const { rerender } = render(
      <TemplatePropertyPanel
        selectedNode={nodes[0] ?? null}
        allNodes={nodes}
        linkedSwitchIdsByHostId={{}}
        platformImageAssets={[]}
        onUpdateNode={onUpdateNode}
      />,
    );

    const passwordInput = screen.getByLabelText('自定义密码') as HTMLInputElement;
    expect(passwordInput.type).toBe('text');
    expect(screen.getByText('留空时，生成实例会为当前 ECS 自动生成随机密码')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /显示密码|隐藏密码/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('自定义密码'), {
      target: { value: 'abcdefgh' },
    });

    expect(onUpdateNode).toHaveBeenLastCalledWith(
      'ecs-1',
      expect.objectContaining({
        customPassword: 'abcdefgh',
      }),
    );

    rerender(
      <TemplatePropertyPanel
        selectedNode={{
          ...(nodes[0] as Extract<TemplateNode, { kind: 'ecs' }>),
          customPassword: 'abcdefgh',
        }}
        allNodes={nodes}
        linkedSwitchIdsByHostId={{}}
        platformImageAssets={[]}
        onUpdateNode={onUpdateNode}
      />,
    );

    expect(
      screen.getByText('Password must include at least three of uppercase, lowercase, number, and special character.'),
    ).toBeTruthy();
  });

  it('clears stale fixed instance type when cpu or memory changes', () => {
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
        imageName: 'ubuntu_22_04_x64_20G_alibase',
        imageId: 'ubuntu_22_04_x64_20G_alibase',
        cpu: 2,
        memory: 2,
        instanceType: 'ecs.e-c1m1.large',
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
        instanceTypeStrategy: { mode: 'fixed', instanceType: 'ecs.e-c1m1.large' },
      },
    ];

    render(
      <TemplatePropertyPanel
        selectedNode={nodes[0] ?? null}
        allNodes={nodes}
        linkedSwitchIdsByHostId={{}}
        platformImageAssets={[]}
        onUpdateNode={onUpdateNode}
      />,
    );

    fireEvent.change(screen.getByLabelText('内存'), {
      target: { value: '4' },
    });

    expect(onUpdateNode).toHaveBeenLastCalledWith(
      'ecs-1',
      expect.objectContaining({
        memory: 4,
        instanceType: undefined,
        instanceTypeStrategy: expect.objectContaining({
          mode: 'fixed',
          instanceType: undefined,
        }),
      }),
    );
  });

  it('keeps custom passwords visible when switching to another ecs node', () => {
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
        customPassword: 'Valid123!',
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
        nics: [{ id: 'ecs-1-nic-1', switchId: '', privateIp: '', secondaryIps: [], securityGroupRules: [] }],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
      {
        id: 'ecs-2',
        kind: 'ecs',
        label: 'ECS 2',
        position: { x: 620, y: 340 },
        instanceName: 'ECS 2',
        hostName: 'ecs-2',
        zoneKey: 'core',
        role: 'host',
        privateIp: '',
        customPassword: 'Another123!',
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
        nics: [{ id: 'ecs-2-nic-1', switchId: '', privateIp: '', secondaryIps: [], securityGroupRules: [] }],
        initScript: '',
        imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
        instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
      },
    ];

    const { rerender } = render(
      <TemplatePropertyPanel
        selectedNode={nodes[0] ?? null}
        allNodes={nodes}
        linkedSwitchIdsByHostId={{}}
        platformImageAssets={[]}
        onUpdateNode={vi.fn()}
      />,
    );

    expect((screen.getByLabelText('自定义密码') as HTMLInputElement).type).toBe('text');
    expect((screen.getByLabelText('自定义密码') as HTMLInputElement).value).toBe('Valid123!');

    rerender(
      <TemplatePropertyPanel
        selectedNode={nodes[1] ?? null}
        allNodes={nodes}
        linkedSwitchIdsByHostId={{}}
        platformImageAssets={[]}
        onUpdateNode={vi.fn()}
      />,
    );

    expect((screen.getByLabelText('自定义密码') as HTMLInputElement).type).toBe('text');
    expect((screen.getByLabelText('自定义密码') as HTMLInputElement).value).toBe('Another123!');
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
