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
      expect(panel.textContent).toContain('当前实例');
    });
  });

  it('renders an optional action slot and omits tabs when views are not supplied', () => {
    render(
      <AdminListToolbar
        action={<button type="button">创建实例</button>}
        onSearchChange={vi.fn()}
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
  });
});
