import React, { Suspense, lazy } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchDetail, router } = vi.hoisted(() => ({ fetchDetail: vi.fn(), router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('./use-admin-session', () => ({ useAdminSession: () => ({ token: 'test-token', profile: { id: 'admin', role: 'admin' }, isReady: true, logout: vi.fn() }) }));
vi.mock('../../lib/admin-api', () => ({ fetchRangeInstanceDetail: fetchDetail }));
vi.mock('./template-editor/topology-flow-canvas', () => ({ TopologyFlowCanvas: ({ mode }: { mode: string }) => <div className="topology-flow-workbench" data-mode={mode}>画布就绪</div> }));
vi.mock('./template-editor/template-property-panel', () => ({ TemplatePropertyPanel: () => <aside className="template-editor-panel template-property-panel">属性面板</aside> }));
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType>, options: { loading: React.ComponentType }) => {
  const Component = lazy(() => load().then((Component) => ({ default: Component })));
  return (props: Record<string, unknown>) => <Suspense fallback={<options.loading />}><Component {...props} /></Suspense>;
} }));

describe('range topology cold chunk transition', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchDetail.mockReset();
    fetchDetail.mockResolvedValue({ id: 'range-1', status: 'destroyed', runtimeTopologyGraph: {
      schemaVersion: '2.0.0', nodes: [{ id: 'router-1', kind: 'router', label: 'Router' }], edges: [],
    } });
  });
  afterEach(() => { cleanup(); vi.doUnmock('./range-instance-topology-workspace'); vi.restoreAllMocks(); });

  it('reserves the same complete canvas and docked pane while a cold chunk is deferred', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let importCount = 0;
    vi.doMock('./range-instance-topology-workspace', async () => {
      importCount += 1;
      await gate;
      return vi.importActual('./range-instance-topology-workspace');
    });
    const module = await import('./range-instance-detail-screen');
    render(<module.RangeInstanceDetailScreen rangeId="range-1" />);
    const tab = await screen.findByRole('tab', { name: '拓扑结构' });
    await waitFor(() => expect(importCount).toBe(1));
    const pending = module.preloadRangeInstanceTopologyWorkspace();
    expect(module.preloadRangeInstanceTopologyWorkspace()).toBe(pending);
    fireEvent.mouseEnter(tab);
    fireEvent.focus(tab);
    fireEvent.mouseDown(tab);
    const placeholder = await screen.findByTestId('range-topology-placeholder');
    expect(placeholder.classList.contains('range-instance-topology-grid')).toBe(true);
    expect(placeholder.querySelector(':scope > .topology-flow-workbench')).not.toBeNull();
    expect(placeholder.querySelector(':scope > .template-property-panel')).not.toBeNull();
    expect(placeholder.querySelector('button, input')).toBeNull();
    expect(screen.queryByText('正在加载拓扑...')).toBeNull();
    await act(async () => { release(); await pending; });
    const loaded = await screen.findByTestId('range-instance-topology-grid');
    expect(loaded.className).toBe(placeholder.className);
    expect(loaded.querySelector('.topology-flow-workbench')?.getAttribute('data-mode')).toBe('readonly');
    expect(loaded.querySelector(':scope > .template-property-panel')).not.toBeNull();
    expect(importCount).toBe(1);
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('range-topology-placeholder')).toBeNull();
  });

  it('allows a failed speculative preload to be retried before the actual mount', async () => {
    vi.doMock('./range-instance-topology-workspace', () => { throw new Error('chunk unavailable'); });
    const module = await import('./range-instance-detail-screen');
    await expect(module.preloadRangeInstanceTopologyWorkspace()).rejects.toThrow();
    vi.doMock('./range-instance-topology-workspace', () => vi.importActual('./range-instance-topology-workspace'));
    await expect(module.preloadRangeInstanceTopologyWorkspace()).resolves.toBeTypeOf('function');
  });

  it('propagates an actual mounted chunk failure instead of keeping a permanent loading frame', async () => {
    vi.doMock('./range-instance-topology-workspace', () => { throw new Error('chunk unavailable'); });
    const module = await import('./range-instance-detail-screen');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      render() { return this.state.failed ? <p role="alert">拓扑组件不可用</p> : this.props.children; }
    }
    render(<Boundary><module.RangeInstanceDetailScreen rangeId="range-1" /></Boundary>);
    const tab = await screen.findByRole('tab', { name: '拓扑结构' });
    fireEvent.mouseDown(tab);
    await screen.findByRole('alert');
    expect(screen.queryByTestId('range-topology-placeholder')).toBeNull();
    consoleError.mockRestore();
  });
});
