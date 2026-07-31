import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminListToolbar } from './admin-list-toolbar';

afterEach(cleanup);

function ControlledAdminListToolbar({
  onSearchChange,
  onViewChange,
}: {
  onSearchChange: (value: string) => void;
  onViewChange: (value: string) => void;
}) {
  const [activeView, setActiveView] = React.useState('history');

  return (
    <AdminListToolbar
      activeView={activeView}
      onSearchChange={onSearchChange}
      onViewChange={(view) => {
        setActiveView(view);
        onViewChange(view);
      }}
      searchLabel="筛选实例名"
      searchPlaceholder="搜索实例名"
      searchValue=""
      views={[
        { value: 'active', label: '实例列表' },
        { value: 'history', label: '实例历史' },
      ]}
    >
      {activeView === 'active' ? <div>当前实例</div> : <div>历史实例</div>}
    </AdminListToolbar>
  );
}

describe('AdminListToolbar', () => {
  it('forwards arbitrary search and keeps the selected keyboard view associated with its panel', async () => {
    const onSearchChange = vi.fn();
    const onViewChange = vi.fn();

    render(<ControlledAdminListToolbar onSearchChange={onSearchChange} onViewChange={onViewChange} />);

    fireEvent.change(screen.getByRole('searchbox', { name: '筛选实例名' }), { target: { value: 'alpha' } });
    const historyTab = screen.getByRole('tab', { name: '实例历史' });
    historyTab.focus();
    fireEvent.keyDown(historyTab, { key: 'ArrowLeft' });

    expect(onSearchChange).toHaveBeenCalledWith('alpha');
    await waitFor(() => {
      const activeTab = screen.getByRole('tab', { name: '实例列表' });
      const panel = screen.getByRole('tabpanel');

      expect(onViewChange).toHaveBeenCalledWith('active');
      expect(activeTab.getAttribute('aria-selected')).toBe('true');
      expect(panel.getAttribute('id')).toBe(activeTab.getAttribute('aria-controls'));
      expect(panel.className).toContain('min-w-0');
      expect(panel.className).toContain('admin-list-toolbar-panel');
      expect(panel.textContent).toContain('当前实例');
    });
  });

  it('renders an optional action slot and omits tabs when views are not supplied', () => {
    render(
      <AdminListToolbar
        action={<button type="button">创建实例</button>}
        onSearchChange={vi.fn()}
        searchControls={<button type="button">全部标签</button>}
        searchLabel="筛选镜像名"
        searchPlaceholder="搜索镜像名"
        searchValue=""
      >
        <div>镜像列表</div>
      </AdminListToolbar>,
    );

    expect(screen.getByRole('button', { name: '创建实例' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.getByText('镜像列表')).toBeTruthy();
    const searchControls = screen.getByTestId('admin-list-toolbar-search-controls');

    expect(searchControls.contains(screen.getByRole('searchbox', { name: '筛选镜像名' }))).toBe(true);
    expect(searchControls.contains(screen.getByRole('button', { name: '全部标签' }))).toBe(true);
    expect(screen.getByRole('searchbox', { name: '筛选镜像名' }).parentElement?.className).toContain('sm:w-60');
    expect(searchControls.className).toContain('sm:shrink-0');
    expect(searchControls.parentElement?.className).toContain('sm:flex-wrap');
  });

  it('reserves a fixed view-action slot for tabbed toolbars', () => {
    render(
      <AdminListToolbar
        activeView="platform"
        onSearchChange={vi.fn()}
        onViewChange={vi.fn()}
        searchLabel="筛选镜像名"
        searchPlaceholder="搜索镜像名"
        searchValue=""
        views={[
          { value: 'platform', label: '平台镜像' },
          { value: 'mine', label: '我的镜像' },
        ]}
      >
        <div>镜像列表</div>
      </AdminListToolbar>,
    );

    const actionSlot = screen.getByTestId('admin-list-toolbar-view-action');

    expect(actionSlot.className).toContain('w-36');
    expect(actionSlot.textContent).toBe('');
  });

  it('can keep a tabbed action adjacent to the view labels', () => {
    render(
      <AdminListToolbar
        action={<button type="button">上传镜像</button>}
        activeView="platform"
        compactViewAction
        onSearchChange={vi.fn()}
        onViewChange={vi.fn()}
        searchLabel="筛选镜像名"
        searchPlaceholder="搜索镜像名"
        searchValue=""
        views={[
          { value: 'platform', label: '平台镜像' },
          { value: 'mine', label: '我的镜像' },
        ]}
      >
        <div>镜像列表</div>
      </AdminListToolbar>,
    );

    const actionSlot = screen.getByTestId('admin-list-toolbar-view-action');

    expect(actionSlot.className).not.toContain('w-36');
    expect(actionSlot.className).toContain('justify-start');
    expect(actionSlot.textContent).toBe('上传镜像');
  });
});
