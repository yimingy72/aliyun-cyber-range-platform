import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PlatformBrand } from './platform-brand';

describe('PlatformBrand', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the platform name and the canonical shield asset at the desktop size', () => {
    render(<PlatformBrand />);

    expect(screen.getByText('综合靶场平台')).toBeTruthy();
    const mark = screen.getByTestId('platform-brand-mark');
    expect(mark.getAttribute('src')).toBe('/brand/platform-mark.svg');
    expect(mark.className).toContain('size-7');
  });

  it('uses the compact mark size for the navigation drawer', () => {
    render(<PlatformBrand compact />);

    expect(screen.getByTestId('platform-brand-mark').className).toContain('size-6');
  });
});
