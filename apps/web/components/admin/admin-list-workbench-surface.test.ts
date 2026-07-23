import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const standardWorkbenchFiles = [
  'users-screen.tsx',
  'image-center-screen.tsx',
  'templates-screen.tsx',
  'range-instances-screen.tsx',
] as const;

describe('admin list workbench surface migration', () => {
  it('puts every standard list route on the shared parent surface', () => {
    for (const filename of standardWorkbenchFiles) {
      const source = readFileSync(resolve(process.cwd(), 'components/admin', filename), 'utf8');

      expect(source).toContain('admin-workbench-surface');
      expect(source).not.toContain('rounded-md border border-border bg-card p-4 shadow-sm');
    }
  });

  it('uses the shared surface for cloud settings without changing the form panel contract', () => {
    const source = readFileSync(resolve(process.cwd(), 'components/admin/settings/settings-screen.tsx'), 'utf8');

    expect(source).toContain('admin-workbench-surface');
    expect(source).toContain('<CloudConfigPanel');
  });
});
