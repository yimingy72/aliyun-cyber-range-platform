// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  updateRangeTemplateMock,
  publishRangeTemplateMock,
  validateRangeTemplateMock,
  fetchPlatformImagesMock,
  fetchPublicImageCatalogScopeMock,
  fetchCustomImageCatalogScopeMock,
  fetchInstanceTypeAvailabilityMock,
} = vi.hoisted(() => ({
  updateRangeTemplateMock: vi.fn(),
  publishRangeTemplateMock: vi.fn(),
  validateRangeTemplateMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  fetchPublicImageCatalogScopeMock: vi.fn(),
  fetchCustomImageCatalogScopeMock: vi.fn(),
  fetchInstanceTypeAvailabilityMock: vi.fn(),
}));

vi.mock('../../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/admin-api')>('../../../lib/admin-api');

  return {
    ...actual,
    updateRangeTemplate: updateRangeTemplateMock,
    publishRangeTemplate: publishRangeTemplateMock,
    validateRangeTemplate: validateRangeTemplateMock,
    fetchPlatformImages: fetchPlatformImagesMock,
    fetchPublicImageCatalogScope: fetchPublicImageCatalogScopeMock,
    fetchCustomImageCatalogScope: fetchCustomImageCatalogScopeMock,
    fetchInstanceTypeAvailability: fetchInstanceTypeAvailabilityMock,
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

function buildUpdatedTemplateResponse(
  payload: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> = {},
) {
  return {
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
      topologyGraph: (payload?.topologyGraph as Record<string, unknown> | undefined) ?? {
        schemaVersion: '2.0.0',
        nodes: [],
        edges: [],
      },
      ...(payload?.topologySpec ? { topologySpec: payload.topologySpec } : {}),
      ...(payload?.scenarioTemplateSpec ? { scenarioTemplateSpec: payload.scenarioTemplateSpec } : {}),
      ...(payload?.compiledProvisionSpec ? { compiledProvisionSpec: payload.compiledProvisionSpec } : {}),
      ...(payload?.compiledSpec ? { compiledSpec: payload.compiledSpec } : {}),
    },
    currentPublishedVersion: {
      id: 'published-1',
      status: 'published',
      version: 'v1.0.0',
      topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  });
  updateRangeTemplateMock.mockImplementation(
    async (_apiBaseUrl: string, _token: string, _id: string, payload: Record<string, unknown>) =>
      buildUpdatedTemplateResponse(payload),
  );
  validateRangeTemplateMock.mockResolvedValue({ valid: true });
  fetchPlatformImagesMock.mockResolvedValue({
    items: [
      {
        id: 'platform-image-1',
        displayName: 'Ubuntu 24.04 LTS',
        imageId: 'ubuntu_24_04_x64_20G_alibase',
        provider: 'alibaba_cloud',
        accountUid: null,
        accountScopeKey: 'public:cn-hangzhou',
        regionId: 'cn-hangzhou',
        sourceScope: 'public',
        sourceSnapshotId: 'snapshot-public-1',
        enabled: true,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
      },
    ],
  });
  fetchPublicImageCatalogScopeMock.mockResolvedValue({
    snapshots: [],
    catalogItems: [
      {
        id: 'catalog-image-public-1',
        displayName: 'Ubuntu 24.04 LTS',
        imageId: 'ubuntu_24_04_x64_20G_alibase',
        provider: 'alibaba_cloud',
        scope: 'public',
        accountUid: null,
        regionId: 'cn-hangzhou',
        enabled: true,
        sourceSnapshotId: 'snapshot-public-1',
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
      },
    ],
  });
  fetchCustomImageCatalogScopeMock.mockResolvedValue({
    snapshots: [],
    catalogItems: [],
  });
  fetchInstanceTypeAvailabilityMock.mockResolvedValue({
    cpu: 1,
    memory: 2,
    regionId: 'cn-hangzhou',
    zoneId: 'cn-hangzhou-h',
    exactAvailable: true,
    matches: [
      {
        instanceTypeId: 'ecs.c7.large',
        cpu: 1,
        memoryGiB: 2,
        family: 'ecs.c7',
        generation: 'ecs-7',
        architecture: 'X86',
      },
    ],
    warning: null,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage?.clear?.();
  updateRangeTemplateMock.mockReset();
  publishRangeTemplateMock.mockReset();
  validateRangeTemplateMock.mockReset();
  fetchPlatformImagesMock.mockReset();
  fetchPublicImageCatalogScopeMock.mockReset();
  fetchCustomImageCatalogScopeMock.mockReset();
  fetchInstanceTypeAvailabilityMock.mockReset();
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

    expect(screen.getByText('企业攻防靶场')).toBeTruthy();
    expect(screen.getByText('资源面板')).toBeTruthy();
    expect(screen.getByText('拓扑画布')).toBeTruthy();
    expect(screen.getByText('属性面板')).toBeTruthy();
    expect(screen.getByRole('button', { name: '检测拓扑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发布编排' })).toBeTruthy();
  });

  it('loads platform image assets only for ecs image options', async () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(fetchPlatformImagesMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchPublicImageCatalogScopeMock).not.toHaveBeenCalled();
    expect(fetchCustomImageCatalogScopeMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    const imageCombobox = screen.getByRole('combobox', { name: '镜像名' });
    expect(imageCombobox).toBeTruthy();
    fireEvent.change(imageCombobox, { target: { value: 'Ubuntu 24.04 LTS' } });
    expect(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' })).toBeTruthy();
  });

  it('supports only router, switch and ecs nodes in the phase-one topology editor', () => {
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

    expect(screen.queryByRole('button', { name: '编辑模式' })).toBeNull();
    expect(screen.queryByRole('button', { name: '连线模式' })).toBeNull();

    expect(screen.getByText('主机设备')).toBeTruthy();
    expect(screen.getByText('网络设备')).toBeTruthy();
    expect(screen.getByText('虚拟主机')).toBeTruthy();
    expect(screen.getByText('路由器')).toBeTruthy();
    expect(screen.getByText('交换机')).toBeTruthy();
    expect(screen.queryByText('点击添加')).toBeNull();
    expect(screen.queryByText('点击添加节点，无需拖动。')).toBeNull();
    expect(screen.queryByRole('button', { name: '生成第一阶段骨架' })).toBeNull();
    expect(screen.getByTestId('template-node-palette-icon-ecs')).toBeTruthy();
    expect(screen.getByTestId('template-node-palette-icon-router')).toBeTruthy();
    expect(screen.getByTestId('template-node-palette-icon-switch')).toBeTruthy();
    expect(screen.queryByText('NAT 网关')).toBeNull();
    expect(screen.queryByText('EIP')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);

    expect(screen.getByRole('button', { name: /ECS 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /交换机 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Router/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));

    expect(screen.getByLabelText('交换机名称')).toBeTruthy();
    expect(screen.getAllByText('交换机 1').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('区域标识')).toBeNull();
  });

  it('uses per-kind naming, keeps router singleton, and assigns the new default switch cidr sequence', () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);

    expect(screen.getByRole('button', { name: /ECS 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /ECS 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /交换机 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /交换机 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /交换机 3/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Router VPC 根节点/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Router 2/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    expect(screen.queryByText('子网信息配置')).toBeNull();
    expect((screen.getByLabelText('CIDR 第一段') as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText('CIDR 第二段') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('CIDR 第三段') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('24');

    fireEvent.click(screen.getByRole('button', { name: /交换机 2/ }));
    expect((screen.getByLabelText('CIDR 第一段') as HTMLInputElement).value).toBe('192');
    expect((screen.getByLabelText('CIDR 第二段') as HTMLInputElement).value).toBe('168');
    expect((screen.getByLabelText('CIDR 第三段') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('24');

    fireEvent.click(screen.getByRole('button', { name: /交换机 3/ }));
    expect((screen.getByLabelText('CIDR 第一段') as HTMLInputElement).value).toBe('172');
    expect((screen.getByLabelText('CIDR 第二段') as HTMLInputElement).value).toBe('16');
    expect((screen.getByLabelText('CIDR 第三段') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('24');

    fireEvent.change(screen.getByLabelText('CIDR 前缀'), { target: { value: '32' } });
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('29');

    fireEvent.change(screen.getByLabelText('CIDR 前缀'), { target: { value: '16' } });
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('17');
  });

  it('shows an inline warning when the selected ecs cpu-memory combination has no exact x86 postpaid match', async () => {
    fetchInstanceTypeAvailabilityMock.mockResolvedValueOnce({
      cpu: 1,
      memory: 2,
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      exactAvailable: false,
      matches: [],
      warning: '当前默认可用区 cn-hangzhou-h 没有精确匹配 1C2G 的 X86 按量付费实例规格。',
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    await waitFor(() =>
      expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        1,
        2,
      ),
    );

    expect(
      await screen.findByText('当前默认可用区 cn-hangzhou-h 没有精确匹配 1C2G 的 X86 按量付费实例规格。'),
    ).toBeTruthy();
  });

  it('rechecks instance type availability when ecs cpu-memory fields change', async () => {
    fetchInstanceTypeAvailabilityMock
      .mockResolvedValueOnce({
        cpu: 1,
        memory: 2,
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        exactAvailable: true,
        matches: [],
        warning: null,
      })
      .mockResolvedValueOnce({
        cpu: 1,
        memory: 4,
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        exactAvailable: true,
        matches: [
          {
            instanceTypeId: 'ecs.g7.large',
            cpu: 1,
            memoryGiB: 4,
            family: 'ecs.g7',
            generation: 'ecs-7',
            architecture: 'X86',
          },
        ],
        warning: null,
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    await waitFor(() => expect(fetchInstanceTypeAvailabilityMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('内存'), {
      target: { value: '4' },
    });

    await waitFor(() =>
      expect(fetchInstanceTypeAvailabilityMock).toHaveBeenNthCalledWith(
        2,
        'http://localhost:3001',
        'dev-admin-token',
        1,
        4,
      ),
    );
  });

  it('creates ecs without default ip and only accepts nic ip values inside the selected switch cidr', () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    const privateIpInput = screen.getByLabelText('私网 IP 1') as HTMLInputElement;
    expect(privateIpInput.value).toBe('');

    fireEvent.change(screen.getByLabelText('交换机标识 1'), { target: { value: 'switch-1' } });
    fireEvent.change(privateIpInput, { target: { value: '192.168.1.10' } });
    expect(privateIpInput.value).toBe('192.168.1.10');
    expect(screen.getByText('私网 IP 不在 10.0.0.0/24 网段内')).toBeTruthy();

    fireEvent.change(privateIpInput, { target: { value: '10.0.8.10' } });
    expect(privateIpInput.value).toBe('10.0.8.10');
  });

  it('creates a persisted edge in online orchestration mode and saves it with the draft topology graph', async () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect(screen.getByTestId('template-canvas-edge-edge-switch-2-ecs-1')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-2' } });
    fireEvent.change(screen.getByLabelText('镜像名'), { target: { value: 'ubuntu_22_04_x64_20G_alibase' } });
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.12' } });
    fireEvent.click(screen.getByRole('button', { name: '检测拓扑' }));
    await waitFor(() => {
      expect(validateRangeTemplateMock).toHaveBeenCalled();
    });

    fireEvent.click(screen.getAllByRole('button', { name: '保存草稿' })[0]!);

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledTimes(2);
    });

    expect(updateRangeTemplateMock).toHaveBeenLastCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'template-1',
      expect.objectContaining({
        topologyGraph: expect.objectContaining({
          edges: expect.arrayContaining([
            expect.objectContaining({
              fromNodeId: 'switch-2',
              toNodeId: 'ecs-1',
            }),
          ]),
        }),
        scenarioTemplateSpec: expect.any(Object),
        compiledProvisionSpec: expect.any(Object),
        compiledSpec: expect.any(Object),
      }),
    );
  });

  it('creates canonical edges even when linking starts from ecs or switch', () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    expect(screen.getByTestId('template-canvas-edge-edge-switch-2-ecs-3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /Router/ }));
    expect(screen.getByTestId('template-canvas-edge-edge-router-1-switch-2')).toBeTruthy();
  });

  it('deletes the selected node and removes its related persisted edges', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect(screen.getByTestId('template-canvas-edge-edge-switch-1-ecs-2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));

    expect(screen.queryByRole('button', { name: /ECS 1/ })).toBeNull();
    expect(screen.queryByTestId('template-canvas-edge-edge-switch-1-ecs-2')).toBeNull();
  });

  it('deletes a selected edge through the delete action', () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    const edge = screen.getByTestId('template-canvas-edge-edge-switch-1-ecs-2');
    fireEvent.click(edge);
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));

    expect(screen.queryByTestId('template-canvas-edge-edge-switch-1-ecs-2')).toBeNull();
  });

  it('clears the ecs nic switch binding when deleting a selected switch-to-ecs edge', () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    const edge = screen.getByTestId('template-canvas-edge-edge-switch-1-ecs-2');
    fireEvent.click(edge);
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));

    expect(screen.queryByTestId('template-canvas-edge-edge-switch-1-ecs-2')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect((screen.getByLabelText('交换机标识 1') as HTMLSelectElement).value).toBe('');
  });

  it('clears invalid nic and dnat references when deleting a node', async () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('交换机标识 1'), { target: { value: 'switch-1' } });

    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
    fireEvent.change(screen.getByLabelText('DNAT 目标主机 1'), { target: { value: 'ecs-2' } });

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));

    expect(screen.getByText('暂无 DNAT 规则')).toBeTruthy();
  });

  it('rejects invalid links outside router -> switch and switch -> ecs in online orchestration mode', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);

    fireEvent.click(screen.getByRole('button', { name: /Router/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect(screen.getByText('第一阶段仅允许 Router -> Switch 或 Switch -> ECS 连线')).toBeTruthy();
    expect(screen.queryByTestId('template-canvas-edge-edge-switch-1-ecs-2')).toBeNull();
  });

  it('renders node-specific property drawer sections for ecs, switch, and router nodes', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '路由器 router' })[0]!);

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByText('基础信息')).toBeTruthy();
    expect(screen.getAllByText('网卡配置').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('主机名')).toBeTruthy();
    expect(screen.queryByLabelText('镜像 ID')).toBeNull();
    expect(screen.getByLabelText('CPU')).toBeTruthy();
    expect(screen.getByLabelText('内存')).toBeTruthy();
    expect((screen.getByLabelText('CPU') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('内存') as HTMLInputElement).value).toBe('2');
    expect(screen.getByText('网卡 1')).toBeTruthy();
    expect(screen.getByLabelText('交换机标识 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加网卡' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除网卡 1' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByLabelText('描述')).toBeNull();
    expect(screen.queryByText('出口配置')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    expect(screen.getByText('基础信息')).toBeTruthy();
    expect(screen.getByText('网段配置')).toBeTruthy();
    expect(screen.getByText('ACL 配置')).toBeTruthy();
    expect(screen.getByText('NAT 配置')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加 ACL 规则' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加 DNAT 规则' })).toBeTruthy();
    expect(screen.queryByLabelText('区域用途')).toBeNull();
    expect(screen.queryByLabelText('镜像 ID')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Router/ }));
    expect(screen.getByLabelText('路由描述')).toBeTruthy();
    expect(screen.queryByLabelText('交换机名称')).toBeNull();
  });

  it('opens node properties on right click without requiring a separate mode switch', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.contextMenu(screen.getByRole('button', { name: /交换机 1/ }));

    expect(screen.getByLabelText('交换机名称')).toBeTruthy();
    expect(screen.queryByText('当前节点')).toBeNull();
    expect(screen.getAllByText('交换机 1').length).toBeGreaterThan(0);
  });

  it('shows orchestration status messages inside the canvas workspace', () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    expect(screen.getByText('已添加ECS 1，可继续补充属性和关系。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByText('已选择连线起点，请点击目标节点完成连接。')).toBeTruthy();
  });

  it('clears pending link state when clicking the empty canvas board', () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByText('已选择连线起点，请点击目标节点完成连接。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('template-canvas-board'));
    expect(screen.queryByText('已选择连线起点，请点击目标节点完成连接。')).toBeNull();
  });

  it('adds structured nic, acl, and dnat cards from the property panel actions', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByLabelText('交换机标识 1')).toBeTruthy();
    fireEvent.click(screen.getByText('添加安全规则 1'));
    expect(screen.getByLabelText('安全方向 1-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加网卡' }));
    expect(screen.getByLabelText('交换机标识 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除网卡 2' }));
    expect(screen.queryByLabelText('交换机标识 2')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加 ACL 规则' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
    expect(screen.getByLabelText('ACL 方向 1')).toBeTruthy();
    expect(screen.getByLabelText('DNAT 目标主机 1')).toBeTruthy();
  });

  it('shows startup fields and supports removing security, acl, and dnat rules', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByLabelText('名称')).toBeTruthy();
    expect(screen.getByText('ECS')).toBeTruthy();
    expect(screen.queryByLabelText('启动优先级')).toBeNull();
    expect(screen.queryByLabelText('启动等待时间')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加安全规则 1' }));
    expect(screen.getByLabelText('安全方向 1-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除安全规则 1-1' }));
    expect(screen.queryByLabelText('安全方向 1-1')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    expect(screen.queryByText('DNAT 用于配置公网到主机端口的入网映射，SNAT 用于开启网段主动出网。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加 ACL 规则' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
    expect(screen.getByLabelText('ACL 方向 1')).toBeTruthy();
    expect(screen.getByLabelText('DNAT 目标主机 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除 ACL 规则 1' }));
    fireEvent.click(screen.getByRole('button', { name: '删除 DNAT 规则 1' }));
    expect(screen.queryByLabelText('ACL 方向 1')).toBeNull();
    expect(screen.queryByLabelText('DNAT 目标主机 1')).toBeNull();
  });

  it('shows policy and priority fields for security and acl rules', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加安全规则 1' }));
    expect(screen.getByLabelText('安全策略 1-1')).toBeTruthy();
    expect(screen.getByLabelText('安全优先级 1-1')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加 ACL 规则' }));
    expect(screen.getByLabelText('ACL 策略 1')).toBeTruthy();
    expect(screen.getByLabelText('ACL 优先级 1')).toBeTruthy();
  });

  it('uses selects for direction and protocol style fields in rule editors', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加安全规则 1' }));
    expect(screen.getByRole('combobox', { name: '安全方向 1-1' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '安全协议 1-1' })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加 ACL 规则' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
    expect(screen.getByRole('combobox', { name: 'ACL 方向 1' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'ACL 协议 1' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'DNAT 协议 1' })).toBeTruthy();
  });

  it('edits switch cidr through segmented subnet controls', () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.change(screen.getByLabelText('CIDR 第一段'), { target: { value: '172' } });
    fireEvent.change(screen.getByLabelText('CIDR 第二段'), { target: { value: '16' } });
    fireEvent.change(screen.getByLabelText('CIDR 第三段'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('CIDR 前缀'), { target: { value: '26' } });

    expect((screen.getByLabelText('CIDR 第一段') as HTMLInputElement).value).toBe('172');
    expect((screen.getByLabelText('CIDR 第二段') as HTMLInputElement).value).toBe('16');
    expect((screen.getByLabelText('CIDR 第三段') as HTMLInputElement).value).toBe('5');
    expect((screen.getByLabelText('CIDR 前缀') as HTMLInputElement).value).toBe('26');
    expect(screen.getByRole('button', { name: /交换机 1 172\.16\.5\.0\/26/ })).toBeTruthy();
  });

  it('uses selects for nic switch binding and dnat target host selection', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.getByRole('combobox', { name: '交换机标识 1' })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加 DNAT 规则' }));
    expect(screen.getByRole('combobox', { name: 'DNAT 目标主机 1' })).toBeTruthy();
  });

  it('does not render inferred edges when the draft graph has no explicit edges', () => {
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
            topologyGraph: {
              schemaVersion: '1.0.0',
              nodes: [
                {
                  id: 'router-core',
                  kind: 'router',
                  label: '主路由',
                  routeRole: 'core',
                  egressType: 'internet',
                  bindEip: false,
                },
                {
                  id: 'switch-dmz',
                  kind: 'switch',
                  label: 'DMZ 交换机',
                  zoneKey: 'dmz',
                  cidr: '10.70.10.0/24',
                  purpose: 'public-entry',
                  description: '',
                  aclRules: [],
                  nat: {
                    snatEnabled: false,
                    dnatMappings: [],
                  },
                },
                {
                  id: 'host-entry',
                  kind: 'ecs',
                  label: '边界主机',
                  instanceName: 'host-entry',
                  hostName: 'host-entry',
                  zoneKey: 'dmz',
                  role: 'entry',
                  privateIp: '10.70.10.10',
                  exposePublic: true,
                  image: 'aliyun_linux_3_x64_20G_alibase',
                  imageName: 'aliyun_linux_3_x64_20G_alibase',
                  imageId: 'aliyun_linux_3_x64_20G_alibase',
                  cpu: 2,
                  memory: 4,
                  description: '',
                  bootPriority: 1,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'dmz', privateIp: '10.70.10.10' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'host-entry-nic-1',
                      switchId: 'switch-dmz',
                      privateIp: '10.70.10.10',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
              ],
              edges: [],
            },
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

    expect(screen.getByTestId('template-canvas-board')).toBeTruthy();
    expect(screen.queryByTestId(/template-canvas-edge/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /边界主机/ }));

    expect(screen.getByLabelText('主机名')).toBeTruthy();
  });

  it('edits a node and keeps the change in local topology state', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-1' } });
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));

    expect((screen.getByLabelText('主机名') as HTMLInputElement).value).toBe('edge-host-1');
  });

  it('recomputes fixed instance type from cpu and memory before validation payload is saved', async () => {
    updateRangeTemplateMock.mockClear();
    validateRangeTemplateMock.mockResolvedValue({ valid: true });

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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-1' } });
    fireEvent.change(screen.getByLabelText('镜像名'), { target: { value: 'aliyun_linux_3_x64_20G_alibase' } });
    fireEvent.keyDown(screen.getByLabelText('镜像名'), { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('交换机标识 1'), { target: { value: 'switch-2' } });
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('内存'), { target: { value: '4' } });

    fireEvent.click(screen.getByRole('button', { name: '检测拓扑' }));

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const latestPayload = updateRangeTemplateMock.mock.calls[0]?.[3];
    expect(latestPayload?.topologyGraph).toEqual(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'ecs-1',
            cpu: 2,
            memory: 4,
            instanceType: 'ecs.c7.large',
            instanceTypeStrategy: {
              mode: 'fixed',
              instanceType: 'ecs.c7.large',
            },
          }),
        ]),
      }),
    );
    expect(latestPayload?.scenarioTemplateSpec?.runtimePreferences?.instanceTypePolicies).toEqual([
      expect.objectContaining({
        key: 'ecs-1-instance-type-policy',
        mode: 'fixed',
        instanceType: 'ecs.c7.large',
      }),
    ]);
    expect(latestPayload?.compiledProvisionSpec?.runtimeSelections?.instanceTypePolicies).toEqual(
      expect.objectContaining({
        'ecs-1-instance-type-policy': expect.objectContaining({
          mode: 'fixed',
          instanceType: 'ecs.c7.large',
        }),
      }),
    );
  });

  it('does not render the old property-panel helper copy or save button', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    expect(screen.queryByText('节点配置')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存属性' })).toBeNull();
  });

  it('blocks incomplete drafts from being saved before topology detection', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    expect(updateRangeTemplateMock).not.toHaveBeenCalled();
    expect(screen.getByText('请先点击“检测拓扑”并通过后，再保存草稿。')).toBeTruthy();
  });

  it('restores stored switch and ecs positions from the saved draft graph after refresh', () => {
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
            topologyGraph: {
              schemaVersion: '2.0.0',
              nodes: [
                {
                  id: 'switch-1',
                  kind: 'switch',
                  label: '交换机 1',
                  position: { x: 400, y: 200 },
                  zoneKey: 'zone-1',
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
                  position: { x: 860, y: 360 },
                  instanceName: 'ECS 1',
                  hostName: 'ecs-1',
                  zoneKey: 'core',
                  role: 'entry',
                  privateIp: '',
                  exposePublic: true,
                  image: 'aliyun_linux_3_x64_20G_alibase',
                  imageName: 'aliyun_linux_3_x64_20G_alibase',
                  imageId: 'aliyun_linux_3_x64_20G_alibase',
                  cpu: 1,
                  memory: 2,
                  description: '',
                  bootPriority: 1,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'core', privateIp: '10.0.0.13' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'ecs-1-nic-1',
                      switchId: 'switch-1',
                      privateIp: '10.0.0.13',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
              ],
              edges: [
                {
                  id: 'edge-switch-1-ecs-1',
                  fromNodeId: 'switch-1',
                  toNodeId: 'ecs-1',
                  relationType: 'manual',
                },
              ],
            },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    expect(screen.getByRole('button', { name: /交换机 1 10.0.0.0\/16/ }).getAttribute('style')).toContain('left: 400px');
    expect(screen.getByRole('button', { name: /ECS 1 10.0.0.13/ }).getAttribute('style')).toContain('left: 860px');
  });

  it('restores unsaved topology from local cache for the same draft version after refresh', () => {
    window.localStorage.setItem(
      'template-editor:draft-cache:template-1:draft-1',
      JSON.stringify({
        schemaVersion: '2.0.0',
        nodes: [
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
        ],
        edges: [],
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    expect(screen.getByRole('button', { name: /ECS 1/ })).toBeTruthy();
  });

  it('preserves persisted top-level instanceType when reloading saved topology graph', async () => {
    updateRangeTemplateMock.mockClear();
    validateRangeTemplateMock.mockResolvedValue({ valid: true });

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
            topologyGraph: {
              schemaVersion: '2.0.0',
              nodes: [
                {
                  id: 'switch-1',
                  kind: 'switch',
                  label: '交换机 1',
                  position: { x: 360, y: 180 },
                  zoneKey: 'zone-1',
                  cidr: '10.0.0.0/24',
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
                  zoneKey: 'zone-1',
                  role: 'entry',
                  privateIp: '10.0.0.13',
                  exposePublic: true,
                  image: 'ubuntu_22_04_x64_20G_alibase',
                  imageName: 'ubuntu_22_04_x64_20G_alibase',
                  imageId: 'ubuntu_22_04_x64_20G_alibase',
                  cpu: 8,
                  memory: 16,
                  instanceType: 'ecs.custom.saved',
                  description: '',
                  bootPriority: 1,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'zone-1', privateIp: '10.0.0.13' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'ecs-1-nic-1',
                      switchId: 'switch-1',
                      privateIp: '10.0.0.13',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
              ],
              edges: [
                {
                  id: 'edge-switch-1-ecs-1',
                  fromNodeId: 'switch-1',
                  toNodeId: 'ecs-1',
                  relationType: 'manual',
                },
              ],
            },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'persisted-instance-type-host' } });
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.click(screen.getByRole('button', { name: '检测拓扑' }));

    expect(screen.getByDisplayValue('persisted-instance-type-host')).toBeTruthy();
    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const latestPayload = updateRangeTemplateMock.mock.calls[0]?.[3];
    expect(latestPayload?.topologyGraph?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-1',
          instanceType: 'ecs.custom.saved',
          instanceTypeStrategy: {
            mode: 'fixed',
            instanceType: 'ecs.custom.saved',
          },
        }),
      ]),
    );
    expect(latestPayload?.scenarioTemplateSpec?.runtimePreferences?.instanceTypePolicies).toEqual([
      expect.objectContaining({
        key: 'ecs-1-instance-type-policy',
        mode: 'fixed',
        instanceType: 'ecs.custom.saved',
      }),
    ]);
    expect(latestPayload?.compiledSpec?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-1',
          type: 'host',
          config: expect.objectContaining({
            instanceType: 'ecs.custom.saved',
            instanceTypeStrategy: {
              mode: 'fixed',
              instanceType: 'ecs.custom.saved',
            },
          }),
        }),
      ]),
    );
  });

  it('stores platformImageAssetId, imageName, imageId, and final instanceType when validating an ecs node', async () => {
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
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /交换机 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(await screen.findByLabelText('镜像名'), {
      target: { value: 'Ubuntu 24.04 LTS' },
    });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    fireEvent.change(screen.getByLabelText('交换机标识 1'), { target: { value: 'switch-2' } });
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.18' } });
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('内存'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'catalog-backed-host' } });
    fireEvent.click(screen.getByRole('button', { name: '检测拓扑' }));

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledTimes(1);
    });

    const latestPayload = updateRangeTemplateMock.mock.calls[0]?.[3];

    expect(latestPayload?.topologyGraph?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-1',
          platformImageAssetId: 'platform-image-1',
          image: 'Ubuntu 24.04 LTS',
          imageName: 'Ubuntu 24.04 LTS',
          imageId: 'ubuntu_24_04_x64_20G_alibase',
          instanceType: 'ecs.c7.xlarge',
        }),
      ]),
    );
    expect(latestPayload?.scenarioTemplateSpec?.runtimePreferences?.imagePolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'ecs-1-image-policy',
          mode: 'fixed',
          imageId: 'ubuntu_24_04_x64_20G_alibase',
        }),
      ]),
    );
    expect(latestPayload?.scenarioTemplateSpec?.runtimePreferences?.instanceTypePolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'ecs-1-instance-type-policy',
          mode: 'fixed',
          instanceType: 'ecs.c7.xlarge',
        }),
      ]),
    );
    expect(latestPayload?.compiledSpec?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ecs-1',
          type: 'host',
          config: expect.objectContaining({
            imageId: 'ubuntu_24_04_x64_20G_alibase',
            instanceType: 'ecs.c7.xlarge',
          }),
        }),
      ]),
    );
  });

  it('keeps the stale fixed instance type persistence regression economy-first when detecting topology', async () => {
    updateRangeTemplateMock.mockClear();
    validateRangeTemplateMock.mockResolvedValue({ valid: true });
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(await screen.findByLabelText('镜像名'), {
      target: { value: 'Ubuntu 24.04 LTS' },
    });
    fireEvent.click(await screen.findByRole('option', { name: 'Ubuntu 24.04 LTS' }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-1' } });
    fireEvent.change(screen.getByLabelText('交换机标识 1'), { target: { value: 'switch-2' } });
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });
    fireEvent.click(screen.getByRole('button', { name: '检测拓扑' }));

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledTimes(1);
    });
    expect(validateRangeTemplateMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'template-1',
    );

    const latestPayload = updateRangeTemplateMock.mock.calls[0]?.[3];
    expect(latestPayload?.compiledSpec).toBeTruthy();
    expect(latestPayload?.scenarioTemplateSpec).toBeTruthy();
    expect(latestPayload?.compiledProvisionSpec).toBeTruthy();
    expect(latestPayload?.compiledSpec).not.toHaveProperty('topologySpec');
    expect(updateRangeTemplateMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'template-1',
      expect.objectContaining({
        topologyGraph: expect.any(Object),
        topologySpec: expect.any(Object),
        compiledSpec: expect.objectContaining({
          schemaVersion: '1.0.0',
          resources: expect.any(Array),
        }),
      }),
    );
    expect(latestPayload?.compiledSpec?.resources[0]).toEqual(expect.objectContaining({
      id: 'ecs-1',
      type: 'host',
      provider: 'alibaba_cloud',
      config: expect.objectContaining({
        dnatMappings: [],
        label: 'ECS 1',
        zoneKey: 'zone-1',
        role: 'host',
        privateIp: '10.0.0.13',
        exposePublic: true,
        image: 'Ubuntu 24.04 LTS',
        imageId: 'ubuntu_24_04_x64_20G_alibase',
        imageName: 'Ubuntu 24.04 LTS',
        instanceName: 'ECS 1',
        hostName: 'edge-host-1',
        cpu: 1,
        memory: 2,
        instanceType: 'ecs.e-c1m1.large',
        networkInterfaces: [
          expect.objectContaining({
            zoneKey: 'core',
            privateIp: '',
          }),
        ],
        nics: [
          expect.objectContaining({
            switchId: 'switch-2',
            privateIp: '10.0.0.13',
          }),
        ],
        portGroups: [],
        initScript: '',
        imageStrategy: {
          mode: 'fixed',
          imageId: 'ubuntu_24_04_x64_20G_alibase',
        },
        instanceTypeStrategy: {
          mode: 'fixed',
          instanceType: 'ecs.e-c1m1.large',
        },
      }),
    }));
    expect(latestPayload?.scenarioTemplateSpec).toEqual(
      expect.objectContaining({
        schemaVersion: '1.0.0',
        topology: expect.objectContaining({
          vpcCidr: '10.0.0.0/16',
          entryHostKey: 'ecs-1',
        }),
        hosts: expect.arrayContaining([
          expect.objectContaining({
            key: 'ecs-1',
            name: 'edge-host-1',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.0.0.13',
          }),
        ]),
        runtimePreferences: expect.objectContaining({
          instanceTypePolicies: [
            expect.objectContaining({
              key: 'ecs-1-instance-type-policy',
              mode: 'fixed',
              instanceType: 'ecs.e-c1m1.large',
            }),
          ],
        }),
      }),
    );
    expect(latestPayload?.compiledProvisionSpec).toEqual(
      expect.objectContaining({
        schemaVersion: '1.0.0',
        topology: expect.objectContaining({
          vpcCidr: '10.0.0.0/16',
          entryHostKey: 'ecs-1',
        }),
        hosts: expect.arrayContaining([
          expect.objectContaining({
            key: 'ecs-1',
            name: 'edge-host-1',
            zoneKey: 'zone-1',
            primaryPrivateIp: '10.0.0.13',
          }),
        ]),
        runtimeSelections: expect.objectContaining({
          instanceTypePolicies: expect.objectContaining({
            'ecs-1-instance-type-policy': expect.objectContaining({
              mode: 'fixed',
              instanceType: 'ecs.e-c1m1.large',
            }),
          }),
        }),
      }),
    );
    expect(screen.getByText('拓扑检测通过，可继续发布编排或创建实例')).toBeTruthy();
  });

  it('blocks saving draft until topology detection passes for the current graph', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    expect(updateRangeTemplateMock).not.toHaveBeenCalled();
    expect(screen.getByText('请先点击“检测拓扑”并通过后，再保存草稿。')).toBeTruthy();
  });

  it('blocks publishing until topology detection passes for the current graph', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: '发布编排' }));

    expect(updateRangeTemplateMock).not.toHaveBeenCalled();
    expect(publishRangeTemplateMock).not.toHaveBeenCalled();
    expect(screen.getByText('请先点击“检测拓扑”并通过后，再发布编排。')).toBeTruthy();
  });

  it('rejects duplicate nic private ips on the same switch during topology detection', async () => {
    updateRangeTemplateMock.mockClear();

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
            topologyGraph: {
              schemaVersion: '2.0.0',
              nodes: [
                {
                  id: 'switch-1',
                  kind: 'switch',
                  label: '交换机 1',
                  position: { x: 360, y: 180 },
                  zoneKey: 'zone-1',
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
                  role: 'entry',
                  privateIp: '',
                  exposePublic: true,
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
                      privateIp: '10.0.0.4',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
                {
                  id: 'ecs-2',
                  kind: 'ecs',
                  label: 'ECS 2',
                  position: { x: 620, y: 300 },
                  instanceName: 'ECS 2',
                  hostName: 'ecs-2',
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
                  bootPriority: 2,
                  bootWaitSeconds: 0,
                  dnatMappings: [],
                  networkInterfaces: [{ zoneKey: 'core', privateIp: '' }],
                  portGroups: [],
                  nics: [
                    {
                      id: 'ecs-2-nic-1',
                      switchId: 'switch-1',
                      privateIp: '10.0.0.4',
                      secondaryIps: [],
                      securityGroupRules: [],
                    },
                  ],
                  initScript: '',
                  imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
                  instanceTypeStrategy: { mode: 'auto', preferredInstanceTypes: [] },
                },
              ],
              edges: [],
            },
          },
          currentPublishedVersion: {
            id: 'published-1',
            status: 'published',
            version: 'v1.0.0',
            topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '检测拓扑' }));

    await waitFor(() => {
      expect(
        screen.getByText(/拓扑检测未通过：交换机 1 中存在重复 IP：10\.0\.0\.4/),
      ).toBeTruthy();
    });
    expect(updateRangeTemplateMock).not.toHaveBeenCalled();
  });

  it('updates node positions in the local topology state when dragging', () => {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    const node = screen.getByRole('button', { name: /ECS 1/ });
    fireEvent.mouseDown(node, { clientX: 620, clientY: 220, button: 0 });
    fireEvent.mouseMove(window, { clientX: 700, clientY: 260 });
    fireEvent.mouseUp(window);

    expect(screen.getByRole('button', { name: /ECS 1/ }).getAttribute('style')).toContain('left: 700px');
    expect(screen.getByRole('button', { name: /ECS 1/ }).getAttribute('style')).toContain('top: 196px');
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-publish' } });
    fireEvent.change(screen.getByLabelText('镜像名'), { target: { value: 'ubuntu_22_04_x64_20G_alibase' } });
    fireEvent.change(screen.getByLabelText('交换机标识 1'), { target: { value: 'switch-2' } });
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });
    fireEvent.click(screen.getByRole('button', { name: '检测拓扑' }));
    await waitFor(() => {
      expect(validateRangeTemplateMock).toHaveBeenCalled();
    });
    fireEvent.click(screen.getAllByRole('button', { name: '发布编排' })[0]!);

    await waitFor(() => {
      expect(publishRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-1',
      );
    });

    expect(screen.getByText('编排已发布，并已生成新的草稿版本')).toBeTruthy();
    expect(screen.getByText('已发布')).toBeTruthy();
  });

  it('shows structured publish precheck errors when publishing fails', async () => {
    publishRangeTemplateMock.mockRejectedValue(
      new AdminApiError(400, '编排发布失败', {
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

    fireEvent.click(screen.getAllByRole('button', { name: '虚拟主机 virtual client' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: '交换机 switch' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ECS 1/ }));
    fireEvent.change(screen.getByLabelText('主机名'), { target: { value: 'edge-host-fail' } });
    fireEvent.change(screen.getByLabelText('镜像名'), { target: { value: 'ubuntu_22_04_x64_20G_alibase' } });
    fireEvent.change(screen.getByLabelText('交换机标识 1'), { target: { value: 'switch-2' } });
    fireEvent.change(screen.getByLabelText('私网 IP 1'), { target: { value: '10.0.0.13' } });
    fireEvent.click(screen.getByRole('button', { name: '检测拓扑' }));
    await waitFor(() => {
      expect(validateRangeTemplateMock).toHaveBeenCalled();
    });
    fireEvent.click(screen.getAllByRole('button', { name: '发布编排' })[0]!);

    await waitFor(() => {
      expect(screen.getByText(/编排发布失败：Missing switch resource for network zone: office；Compiled public entry host must expose public access: dmz-entry/)).toBeTruthy();
    });
  });


  it('does not expose extended network resource entry points in phase one', () => {
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

    expect(screen.queryByRole('button', { name: /NAT 网关/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^EIP/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /ACL/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /安全组规则/i })).toBeNull();
  });
});
