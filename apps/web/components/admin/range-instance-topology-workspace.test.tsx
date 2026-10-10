// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RangeInstanceTopologyWorkspace } from './range-instance-topology-workspace';
import type { TemplateEdge } from './template-editor/template-editor-screen';
import type { TemplateNode } from '../../lib/scenario-graph';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  });
});

const switchNode: TemplateNode = {
  id: 'switch-dmz',
  kind: 'switch',
  label: 'DMZ 交换机',
  zoneKey: 'dmz',
  cidr: '10.70.10.0/24',
  purpose: 'dmz',
  aclRules: [],
  nat: {
    dnatMappings: [],
    snatEnabled: false,
  },
};

const ecsNode: TemplateNode = {
  id: 'ecs-web',
  kind: 'ecs',
  label: 'Web ECS',
  zoneKey: 'dmz',
  role: 'web',
  privateIp: '10.70.10.10',
  exposePublic: true,
  image: 'aliyun_linux_3_x64_20G_alibase',
  dnatMappings: [],
  networkInterfaces: [{ zoneKey: 'dmz', privateIp: '10.70.10.10' }],
  nics: [{
    id: 'ecs-web-nic-1',
    switchId: 'switch-dmz',
    privateIp: '10.70.10.10',
    secondaryIps: [],
    securityGroupRules: [],
  }],
  portGroups: [],
  initScript: '',
  imageStrategy: { mode: 'fixed', imageId: 'aliyun_linux_3_x64_20G_alibase' },
  instanceTypeStrategy: { mode: 'auto' },
};

const edges: TemplateEdge[] = [{
  id: 'edge-dmz-web',
  fromNodeId: 'switch-dmz',
  toNodeId: 'ecs-web',
  relationType: 'manual',
}];

function createWorkspaceProps(editable: boolean) {
  return {
    edges,
    editable,
    instanceTypeAvailability: null,
    linkedSwitchIdsByHostId: {
      'ecs-web': ['switch-dmz'],
    },
    nodes: [switchNode, ecsNode],
    onAddNode: vi.fn(),
    onConnect: vi.fn(),
    onDeleteSelection: vi.fn(),
    onLayoutAll: vi.fn(),
    onNodeActivate: vi.fn(),
    onPositionsCommit: vi.fn(),
    onRedo: vi.fn(),
    onSelectionChange: vi.fn(),
    onUndo: vi.fn(),
    onUpdateNode: vi.fn(),
    onViewportCommit: vi.fn(),
    platformImageAssets: [],
    runtimeNodeStatus: 'running',
    selection: {
      edgeIds: [],
      nodeIds: ['ecs-web'],
    },
    viewport: {
      x: -80,
      y: 24,
      zoom: 1,
    },
  };
}

describe('RangeInstanceTopologyWorkspace', () => {
  it('renders the shared flow workbench with an editable instance property panel', () => {
    render(<RangeInstanceTopologyWorkspace {...(createWorkspaceProps(true) as any)} />);

    expect(screen.getByTestId('topology-flow-workbench')).toBeTruthy();
    expect(screen.getByRole('button', { name: '连线模式' })).toBeTruthy();
    expect(screen.getByTestId('topology-resource-rail')).toBeTruthy();
    expect((screen.getByLabelText('名称') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('交换机标识 1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders a readonly flow workbench and disables the historical instance property panel', () => {
    render(<RangeInstanceTopologyWorkspace {...(createWorkspaceProps(false) as any)} />);

    expect(screen.getByTestId('topology-flow-workbench').getAttribute('data-mode')).toBe('readonly');
    expect(screen.queryByRole('button', { name: '连线模式' })).toBeNull();
    expect((screen.getByLabelText('名称') as HTMLInputElement).matches(':disabled')).toBe(true);
    expect((screen.getByLabelText('交换机标识 1') as HTMLButtonElement).matches(':disabled')).toBe(true);
  });

  it('declares a fullscreen-capable three-column instance topology grid', () => {
    const styles = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');

    expect(styles).toMatch(
      /\.range-instance-topology-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    );
    expect(styles).toContain('.range-instance-topology-grid:fullscreen');
    expect(styles).toContain(
      '.range-instance-topology-grid:has(.topology-flow-workbench) > .template-property-panel',
    );
  });
});

it('locks deployed node configuration while keeping new draft nodes editable', () => {
  const props = createWorkspaceProps(true);
  const { rerender } = render(<RangeInstanceTopologyWorkspace {...props} deployedNodeIds={[ecsNode.id, switchNode.id]} />);
  expect(screen.getByLabelText('CPU').matches(':disabled')).toBe(true);
  expect((screen.getByLabelText('交换机标识 1') as HTMLButtonElement).disabled).toBe(true);
  rerender(<RangeInstanceTopologyWorkspace {...props} deployedNodeIds={[switchNode.id]} />);
  expect(screen.getByLabelText('CPU').matches(':disabled')).toBe(false);
  expect((screen.getByLabelText('交换机标识 1') as HTMLButtonElement).disabled).toBe(false);
});
