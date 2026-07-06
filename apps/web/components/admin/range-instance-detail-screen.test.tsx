import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RangeInstanceDetailScreen } from './range-instance-detail-screen';

describe('RangeInstanceDetailScreen', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the standalone detail route shell', () => {
    render(<RangeInstanceDetailScreen rangeId="range-1" />);

    expect(screen.getByRole('heading', { name: '实例详情' })).toBeTruthy();
    expect(screen.getByText('range-1')).toBeTruthy();
  });
});
