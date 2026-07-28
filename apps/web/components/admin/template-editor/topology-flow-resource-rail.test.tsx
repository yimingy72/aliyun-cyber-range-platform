// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopologyFlowResourceRail } from './topology-flow-resource-rail';

afterEach(() => {
  cleanup();
});

describe('TopologyFlowResourceRail', () => {
  it('默认保持资源工具轨收缩，并可展开和关闭资源面板', () => {
    render(<TopologyFlowResourceRail onAddNode={vi.fn()} />);

    expect(screen.getByTestId('topology-resource-rail').getAttribute('data-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: '打开资源面板' }).getAttribute('title')).toBe('打开资源面板');
    expect(screen.queryByTestId('topology-resource-palette')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '打开资源面板' }));

    expect(screen.getByTestId('topology-resource-rail').getAttribute('data-expanded')).toBe('true');
    expect(screen.getByTestId('topology-resource-palette')).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭资源面板' }).getAttribute('title')).toBe('关闭资源面板');

    fireEvent.click(screen.getByRole('button', { name: '关闭资源面板' }));

    expect(screen.getByTestId('topology-resource-rail').getAttribute('data-expanded')).toBe('false');
    expect(screen.queryByTestId('topology-resource-palette')).toBeNull();
  });

  it('点击 ECS 主机时请求添加 ecs 节点', () => {
    const onAddNode = vi.fn();
    render(<TopologyFlowResourceRail onAddNode={onAddNode} />);

    fireEvent.click(screen.getByRole('button', { name: '打开资源面板' }));
    fireEvent.click(screen.getByRole('button', { name: /ECS 主机/ }));

    expect(onAddNode).toHaveBeenCalledWith('ecs');
  });

  it('资源面板仅呈现 router、switch 和 ecs，并在拖动时写入节点类型', () => {
    render(<TopologyFlowResourceRail onAddNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '打开资源面板' }));

    const resourceButtons = screen.getAllByTestId('topology-resource-entry');
    expect(resourceButtons.map((entry) => entry.getAttribute('data-kind'))).toEqual(['router', 'switch', 'ecs']);

    const dataTransfer = {
      effectAllowed: '',
      setData: vi.fn(),
    };
    fireEvent.dragStart(screen.getByRole('button', { name: /ECS 主机/ }), { dataTransfer });

    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.setData).toHaveBeenCalledWith('application/x-topology-node-kind', 'ecs');
  });
});
