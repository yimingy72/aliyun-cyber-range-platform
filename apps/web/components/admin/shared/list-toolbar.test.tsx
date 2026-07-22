import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ListToolbar } from './list-toolbar';

afterEach(cleanup);

function ControlledListToolbar({ onSearchChange }: { onSearchChange: (value: string) => void }) {
  const [activeView, setActiveView] = React.useState<'mine' | 'platform'>('mine');

  return (
    <ListToolbar
      searchValue=""
      activeView={activeView}
      onSearchChange={onSearchChange}
      onViewChange={setActiveView}
    >
      <div>靶场列表</div>
    </ListToolbar>
  );
}

describe('ListToolbar', () => {
  it('forwards search and keyboard view changes through its controlled props', async () => {
    const onSearchChange = vi.fn();

    render(<ControlledListToolbar onSearchChange={onSearchChange} />);

    const searchInput = screen.getByRole('searchbox', { name: '筛选靶场名' });
    const activeTab = screen.getByRole('tab', { name: '我的拓扑' });
    expect(searchInput.getAttribute('type')).toBe('search');
    const tabList = screen.getByRole('tablist', { name: '靶场编排视图' });
    expect(screen.getByRole('tabpanel').textContent).toContain('靶场列表');
    expect(activeTab.getAttribute('aria-selected')).toBe('true');

    fireEvent.change(searchInput, { target: { value: '办公网' } });
    tabList.focus();
    fireEvent.keyDown(activeTab, { key: 'ArrowRight' });

    expect(onSearchChange).toHaveBeenCalledWith('办公网');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '平台拓扑' }).getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('tabpanel').textContent).toContain('靶场列表');
    });
  });
});
