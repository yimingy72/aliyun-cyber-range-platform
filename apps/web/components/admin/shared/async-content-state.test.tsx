import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AsyncContentState } from './async-content-state';

afterEach(cleanup);

describe('AsyncContentState', () => {
  it('offers one retry action for an error state', () => {
    const onRetry = vi.fn();

    render(
      <AsyncContentState
        title="加载失败"
        description="暂时无法读取靶场列表。"
        variant="error"
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders an empty-state action without a retry button', () => {
    render(
      <AsyncContentState
        title="暂无靶场"
        description="创建第一个靶场开始编排。"
        variant="empty"
        action={<button type="button">新建靶场</button>}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '新建靶场' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试加载' })).toBeNull();
  });
});
