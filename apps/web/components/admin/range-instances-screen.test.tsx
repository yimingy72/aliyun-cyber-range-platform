import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: vi.fn(),
  }),
}));

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    token: 'dev-admin-token',
    isReady: true,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('../../lib/admin-api', () => ({
  fetchAdminBootstrap: vi.fn().mockResolvedValue({
    competitions: [{ id: 'competition-1', name: '总决赛' }],
    teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
    rangeTemplates: [{ id: 'template-1', slug: 'enterprise-range', version: 'v1' }],
    rangeInstances: [
      { id: 'range-1', teamId: 'team-1', status: 'running', lastJobId: 'job-1', errorSummary: null },
      { id: 'range-2', teamId: 'team-1', status: 'create_failed', lastJobId: 'job-2', errorSummary: '规格不可售' },
    ],
    provisionJobs: [],
  }),
  fetchRangeInstanceDetail: vi.fn().mockResolvedValue({
    id: 'range-1',
    status: 'running',
    teamId: 'team-1',
    competitionId: 'competition-1',
    templateId: 'template-1',
    accessEntry: { publicIp: '47.1.1.1', ssh: 'ssh root@47.1.1.1' },
    resourceSummary: { vpcId: 'vpc-123' },
  }),
  triggerRangeAction: vi.fn().mockResolvedValue({
    id: 'job-3',
    rangeInstanceId: 'range-1',
    jobType: 'destroy',
    status: 'pending',
    triggeredBy: 'admin',
  }),
}));

import { RangeInstancesScreen } from './range-instances-screen';

describe('RangeInstancesScreen', () => {
  it('opens the selected instance detail and shows the public access ip', async () => {
    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('靶场实例');
    fireEvent.click(screen.getByRole('button', { name: '查看实例 range-1' }));

    await screen.findByText('公网入口');
    expect(screen.getByText('47.1.1.1')).toBeTruthy();
  });
});
