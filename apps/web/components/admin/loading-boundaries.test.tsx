import { describe, expect, it, vi } from 'vitest';

const { dynamicMock } = vi.hoisted(() => ({
  dynamicMock: vi.fn(() => () => null),
}));

vi.mock('next/dynamic', () => ({
  default: dynamicMock,
}));

import './range-instance-detail-screen';
import './template-editor/template-editor-screen';

describe('admin loading boundaries', () => {
  it('defers the topology-only modules from the default route bundles', () => {
    const loaderSources = dynamicMock.mock.calls.map(([loader]) => String(loader)).join('\n');

    expect(loaderSources).toContain('/components/admin/range-instance-topology-workspace.tsx');
    expect(loaderSources).toContain('/components/admin/template-editor/template-property-panel.tsx');
  });
});
