import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StatusBadge } from './status-badge';

afterEach(cleanup);

describe('StatusBadge', () => {
  it.each([
    ['pending_create', '等待创建', 'secondary'],
    ['pending_destroy', '等待销毁', 'secondary'],
    ['running', '运行中', 'default'],
    ['creating', '创建中', 'secondary'],
    ['create_failed', '创建失败', 'destructive'],
    ['destroying', '销毁中', 'secondary'],
    ['destroy_failed', '销毁失败', 'destructive'],
    ['destroyed', '已销毁', 'outline'],
    ['draft', '草稿', 'outline'],
    ['pending', '处理中', 'secondary'],
    ['failed', '失败', 'destructive'],
    ['succeeded', '已完成', 'default'],
    ['active', '已激活', 'default'],
    ['enabled', '已启用', 'default'],
    ['disabled', '已停用', 'secondary'],
    ['published', '已发布', 'default'],
    ['private', '私有', 'secondary'],
  ] as const)('renders the %s API status with its standard label and tone', (status, label, variant) => {
    render(<StatusBadge status={status} />);

    const badge = screen.getByText(label);
    expect(badge.getAttribute('data-status')).toBe(status);
    expect(badge.getAttribute('data-variant')).toBe(variant);
  });

  it('renders an unknown API status with a safe neutral fallback', () => {
    render(<StatusBadge status="future_backend_status" />);

    const badge = screen.getByText('状态未知');
    expect(badge.getAttribute('data-status')).toBe('future_backend_status');
    expect(badge.getAttribute('data-variant')).toBe('outline');
  });

  it('treats prototype-chain status keys as unknown', () => {
    render(<StatusBadge status="constructor" />);

    const badge = screen.getByText('状态未知');
    expect(badge.getAttribute('data-status')).toBe('constructor');
    expect(badge.getAttribute('data-variant')).toBe('outline');
  });
});
