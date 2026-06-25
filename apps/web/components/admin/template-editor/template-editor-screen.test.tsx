import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { updateRangeTemplateMock, publishRangeTemplateMock } = vi.hoisted(() => ({
  updateRangeTemplateMock: vi.fn(),
  publishRangeTemplateMock: vi.fn(),
}));

vi.mock('../../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/admin-api')>('../../../lib/admin-api');

  return {
    ...actual,
    updateRangeTemplate: updateRangeTemplateMock,
    publishRangeTemplate: publishRangeTemplateMock,
  };
});
import { AdminApiError } from '../../../lib/admin-api';
import { TemplateEditorScreen } from './template-editor-screen';

vi.mock('../use-admin-session', () => ({
  useAdminSession: () => ({
    isReady: true,
    token: 'dev-admin-token',
    logout: () => undefined,
  }),
}));

afterEach(() => {
  cleanup();
  updateRangeTemplateMock.mockReset();
  publishRangeTemplateMock.mockReset();
});

describe('TemplateEditorScreen', () => {
  it('renders a topology editor workspace with palette, canvas, and property panel', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: '企业攻防靶场' })).toBeTruthy();
    expect(screen.getByText('节点库')).toBeTruthy();
    expect(screen.getByText('拓扑画布')).toBeTruthy();
    expect(screen.getByText('属性面板')).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发布模板' })).toBeTruthy();
  });

  it('adds nodes from the palette and shows the selected node in the property panel', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '主机 ECS / 跳板机 / 域控 / 数据库' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 子网 / 网段 / ACL / NAT' })[0]!);

    expect(screen.getByText('2 节点 / 0 连线')).toBeTruthy();
    expect(screen.getByRole('button', { name: /主机 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /交换机 2/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /交换机 2/ }));

    expect(screen.getByLabelText('交换机名称')).toBeTruthy();
    expect(screen.getAllByText('交换机 2').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('区域标识')).toBeTruthy();
  });

  it('edits a node and saves the draft topology graph', async () => {
    updateRangeTemplateMock.mockResolvedValue({
      id: 'template-1',
      name: '企业攻防靶场',
      slug: 'enterprise-range',
      version: 'v1.1.0',
      currentDraftVersionId: 'draft-2',
      currentPublishedVersionId: 'published-1',
      currentDraftVersion: {
        id: 'draft-2',
        status: 'draft',
        version: 'v1.1.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
      currentPublishedVersion: {
        id: 'published-1',
        status: 'published',
        version: 'v1.0.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
    });

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '主机 ECS / 跳板机 / 域控 / 数据库' })[0]!);
    fireEvent.change(screen.getByLabelText('主机名称'), { target: { value: '边界主机' } });
    fireEvent.change(screen.getByLabelText('所属区域'), { target: { value: 'dmz' } });
    fireEvent.change(screen.getByLabelText('主机角色'), { target: { value: 'entry' } });
    fireEvent.change(screen.getByLabelText('私网 IP'), { target: { value: '10.0.1.10' } });

    fireEvent.click(screen.getAllByRole('button', { name: '保存草稿' })[0]!);

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-1',
        expect.objectContaining({
          topologyGraph: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({
                label: '边界主机',
                zoneKey: 'dmz',
                role: 'entry',
                privateIp: '10.0.1.10',
              }),
            ]),
          }),
        }),
      );
    });

    expect(screen.getByText('草稿已保存')).toBeTruthy();
  });

  it('compiles topology graph into compiledSpec when saving draft', async () => {
    updateRangeTemplateMock.mockClear();
    updateRangeTemplateMock.mockResolvedValue({
      id: 'template-1',
      name: '企业攻防靶场',
      slug: 'enterprise-range',
      version: 'v1.1.0',
      currentDraftVersionId: 'draft-2',
      currentPublishedVersionId: 'published-1',
      currentDraftVersion: {
        id: 'draft-2',
        status: 'draft',
        version: 'v1.1.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
      currentPublishedVersion: {
        id: 'published-1',
        status: 'published',
        version: 'v1.0.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
    });

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '主机 ECS / 跳板机 / 域控 / 数据库' })[0]!);
    fireEvent.change(screen.getByLabelText('主机名称'), { target: { value: '边界主机' } });
    fireEvent.change(screen.getByLabelText('所属区域'), { target: { value: 'dmz-a' } });
    fireEvent.change(screen.getByLabelText('主机角色'), { target: { value: 'entry' } });
    fireEvent.change(screen.getByLabelText('私网 IP'), { target: { value: '10.0.1.10' } });
    fireEvent.change(screen.getByLabelText('镜像'), { target: { value: 'aliyun_linux_3_x64_20G_alibase' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存草稿' })[0]!);

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const latestPayload = updateRangeTemplateMock.mock.calls[0]?.[3];
    expect(latestPayload?.compiledSpec).toBeTruthy();
    expect(latestPayload?.compiledSpec).not.toHaveProperty('topologySpec');
    expect(updateRangeTemplateMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'template-1', {
      topologyGraph: expect.any(Object),
      compiledSpec: {
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
        ],
      },
      topologySpec: expect.any(Object),
    });
    expect(latestPayload?.compiledSpec?.resources[0]).toEqual({
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
    });
    expect(Object.keys(latestPayload?.compiledSpec?.resources[0]?.config ?? {}).sort()).toEqual([
      'exposePublic',
      'image',
      'label',
      'privateIp',
      'role',
      'zoneKey',
    ]);
  });

  it('publishes the template and refreshes published and draft version status', async () => {
    publishRangeTemplateMock.mockResolvedValue({
      id: 'template-1',
      name: '企业攻防靶场',
      slug: 'enterprise-range',
      version: 'v1.2.0',
      currentDraftVersionId: 'draft-3',
      currentPublishedVersionId: 'published-2',
      currentDraftVersion: {
        id: 'draft-3',
        status: 'draft',
        version: 'v1.2.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
      currentPublishedVersion: {
        id: 'published-2',
        status: 'published',
        version: 'v1.2.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
    });

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '发布模板' })[0]!);

    await waitFor(() => {
      expect(publishRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-1',
      );
    });

    expect(screen.getByText('模板已发布，并已生成新的草稿版本')).toBeTruthy();
    expect(screen.getByText('已发布 v1.2.0 / 草稿 v1.2.0')).toBeTruthy();
  });

  it('shows structured publish precheck errors when publishing fails', async () => {
    publishRangeTemplateMock.mockRejectedValue(
      new AdminApiError(400, '模板发布失败', {
        message: [
          'Missing switch resource for network zone: office',
          'Compiled public entry host must expose public access: dmz-entry',
        ],
      }),
    );

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '发布模板' })[0]!);

    await waitFor(() => {
      expect(screen.getByText(/模板发布失败：Missing switch resource for network zone: office；Compiled public entry host must expose public access: dmz-entry/)).toBeTruthy();
    });
  });

  it('bootstraps an enterprise range skeleton into the editor', () => {
    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '生成企业骨架' }));

    expect(screen.getByRole('button', { name: /DMZ 交换机/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /办公网主机/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /数据库主机/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /公网出口路由/ })).toBeTruthy();
    expect(screen.getByText('已生成企业靶场默认骨架')).toBeTruthy();
  });

  it('saves a generated enterprise skeleton as a formal topologySpec', async () => {
    updateRangeTemplateMock.mockClear();
    updateRangeTemplateMock.mockResolvedValue({
      id: 'template-1',
      name: '企业攻防靶场',
      slug: 'enterprise-range',
      version: 'v1.1.0',
      currentDraftVersionId: 'draft-2',
      currentPublishedVersionId: 'published-1',
      currentDraftVersion: {
        id: 'draft-2',
        status: 'draft',
        version: 'v1.1.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
      currentPublishedVersion: {
        id: 'published-1',
        status: 'published',
        version: 'v1.0.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
    });

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '生成企业骨架' }));
    fireEvent.click(screen.getAllByRole('button', { name: '保存草稿' })[0]!);

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const latestPayload = updateRangeTemplateMock.mock.calls[0]?.[3];
    expect(latestPayload?.topologySpec).toEqual({
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
      ],
      publicEntry: {
        hostKey: 'host-dmz-entry',
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
    });
  });

  it('adds extended network resources and persists them into compiledSpec on draft save', async () => {
    updateRangeTemplateMock.mockResolvedValue({
      id: 'template-1',
      name: '企业攻防靶场',
      slug: 'enterprise-range',
      version: 'v1.1.0',
      currentDraftVersionId: 'draft-2',
      currentPublishedVersionId: 'published-1',
      currentDraftVersion: {
        id: 'draft-2',
        status: 'draft',
        version: 'v1.1.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
      currentPublishedVersion: {
        id: 'published-1',
        status: 'published',
        version: 'v1.0.0',
        topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      },
    });

    render(
      <TemplateEditorScreen
        template={{
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1.1.0',
          currentDraftVersionId: 'draft-1',
          currentPublishedVersionId: 'published-1',
          currentDraftVersion: {
            id: 'draft-1',
            status: 'draft',
            version: 'v1.1.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'NAT 网关 子网 SNAT / DNAT / 出口能力' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /NAT 网关 1/ }));
    fireEvent.change(screen.getByLabelText('NAT 网关名称'), { target: { value: '办公区 NAT' } });
    fireEvent.change(screen.getByLabelText('所属区域'), { target: { value: 'office' } });

    fireEvent.click(screen.getAllByRole('button', { name: 'EIP 公网 IP / 入口绑定 / 出口绑定' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /EIP 2/ }));
    fireEvent.change(screen.getByLabelText('EIP 名称'), { target: { value: '办公出口 EIP' } });
    fireEvent.change(screen.getByLabelText('绑定目标类型'), { target: { value: 'nat_gateway' } });
    fireEvent.change(screen.getByLabelText('绑定目标标识'), { target: { value: 'nat_gateway-1' } });
    fireEvent.change(screen.getByLabelText('带宽 Mbps'), { target: { value: '25' } });

    fireEvent.click(screen.getAllByRole('button', { name: '保存草稿' })[0]!);

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const payload = updateRangeTemplateMock.mock.calls[0]?.[3];
    expect(payload?.compiledSpec?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'nat_gateway-1',
          type: 'nat_gateway',
          config: {
            label: '办公区 NAT',
            zoneKey: 'office',
            snatEnabled: false,
          },
        }),
        expect.objectContaining({
          id: 'eip-2',
          type: 'eip',
          config: {
            label: '办公出口 EIP',
            bindTargetType: 'nat_gateway',
            bindTargetKey: 'nat_gateway-1',
            bandwidthMbps: 25,
          },
        }),
      ]),
    );
  });
});
