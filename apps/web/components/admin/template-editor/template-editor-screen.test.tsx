import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
import { TemplateEditorScreen } from './template-editor-screen';

vi.mock('../use-admin-session', () => ({
  useAdminSession: () => ({
    isReady: true,
    token: 'dev-admin-token',
    logout: () => undefined,
  }),
}));

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
    fireEvent.click(screen.getAllByRole('button', { name: '保存草稿' })[0]!);

    await waitFor(() => {
      expect(updateRangeTemplateMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'template-1',
        expect.objectContaining({
          compiledSpec: expect.objectContaining({
            schemaVersion: '1.0.0',
            resources: expect.arrayContaining([
              expect.objectContaining({ id: 'host-1', type: 'host' }),
            ]),
          }),
        }),
      );
    });
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
});
