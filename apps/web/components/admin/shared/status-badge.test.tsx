import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StatusBadge } from './status-badge';

afterEach(cleanup);

describe('StatusBadge', () => {
  it('renders the published status with the primary badge treatment', () => {
    render(<StatusBadge status="published" />);

    const badge = screen.getByText('已发布');
    expect(badge.getAttribute('data-status')).toBe('published');
    expect(badge.getAttribute('data-variant')).toBe('default');
  });

  it('renders the private status with the secondary badge treatment', () => {
    render(<StatusBadge status="private" />);

    const badge = screen.getByText('私有');
    expect(badge.getAttribute('data-status')).toBe('private');
    expect(badge.getAttribute('data-variant')).toBe('secondary');
  });
});
