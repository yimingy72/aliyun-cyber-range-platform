import { render, screen } from '@testing-library/react';

import HomePage from './page';

describe('HomePage', () => {
  it('shows the platform value proposition', () => {
    render(<HomePage />);

    expect(screen.getByRole('heading', { name: /cyber range control center/i }).textContent).toBe(
      'Cyber Range Control Center'
    );
  });
});
