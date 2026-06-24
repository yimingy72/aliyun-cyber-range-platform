import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    token: 'dev-admin-token',
    isReady: true,
    logout: vi.fn(),
  }),
}));

vi.mock('../../lib/admin-api', () => ({
  fetchAdminBootstrap: vi.fn().mockResolvedValue({
    competitions: [{ id: 'competition-1', name: '总决赛' }],
    teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
    rangeTemplates: [{ id: 'template-1', slug: 'enterprise-range', version: 'v1' }],
    rangeInstances: [
      { id: 'range-1', teamId: 'team-1', status: 'running', errorSummary: null, lastJobId: 'job-1' },
      { id: 'range-2', teamId: 'team-1', status: 'create_failed', errorSummary: 'EIP failed', lastJobId: 'job-2' },
    ],
    provisionJobs: [
      { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'succeeded', triggeredBy: 'admin' },
      { id: 'job-2', rangeInstanceId: 'range-2', jobType: 'create', status: 'running', triggeredBy: 'admin' },
    ],
  }),
}));

import { OverviewScreen } from './overview-screen';

describe('OverviewScreen', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders Chinese KPI cards and recent activity sections', async () => {
    render(<OverviewScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('靶场总览');
    expect(screen.getByText('运行中靶场')).toBeTruthy();
    expect(screen.getByText('创建中任务')).toBeTruthy();
    expect(screen.getByText('失败实例')).toBeTruthy();
    expect(screen.getByText('最近任务')).toBeTruthy();
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.queryByText('Provisioning')).toBeNull();
    expect(screen.queryByText('Failures')).toBeNull();
    expect(screen.queryByText('Templates')).toBeNull();
    expect(screen.queryByText('Recent Jobs')).toBeNull();
  });
});
