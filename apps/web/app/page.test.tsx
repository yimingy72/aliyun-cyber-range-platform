import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import HomePage from './page';

describe('HomePage', () => {
  it('shows the platform value proposition', () => {
    const description =
      'A control surface for competition operators to create, observe, and retire per-team VPC ranges on Alibaba Cloud.';

    render(<HomePage />);

    expect(screen.getByRole('heading', { name: /cyber range control center/i }).textContent).toBe(
      'Cyber Range Control Center'
    );
    expect(screen.getByText(description).textContent).toBe(description);
  });
});
