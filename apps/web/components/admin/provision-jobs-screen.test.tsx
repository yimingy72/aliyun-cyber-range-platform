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
    competitions: [],
    teams: [],
    rangeTemplates: [],
    rangeInstances: [],
    provisionJobs: [
      {
        id: 'job-1',
        rangeInstanceId: 'range-1',
        jobType: 'create',
        status: 'failed',
        triggeredBy: 'admin',
        startedAt: '2026-06-24T09:30:00.000Z',
        errorSummary: 'EIP 分配失败',
      },
    ],
  }),
  fetchProvisionJobDetail: vi.fn().mockResolvedValue({
    job: {
      id: 'job-1',
      rangeInstanceId: 'range-1',
      jobType: 'create',
      status: 'failed',
      triggeredBy: 'admin',
      startedAt: '2026-06-24T09:30:00.000Z',
      errorSummary: 'EIP 分配失败',
    },
    steps: [
      {
        id: 'step-1',
        jobId: 'job-1',
        stepName: 'allocate-eip',
        status: 'failed',
        message: 'EIP 配额不足',
        stdoutExcerpt: 'requestRegion=cn-hangzhou',
        stderrExcerpt: 'QuotaExceeded',
        startedAt: '2026-06-24T09:31:00.000Z',
        finishedAt: '2026-06-24T09:31:30.000Z',
      },
    ],
  }),
}));

import { ProvisionJobsScreen } from './provision-jobs-screen';

describe('ProvisionJobsScreen', () => {
  it('shows started time, failure summary, and step log output in job detail', async () => {
    render(<ProvisionJobsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('编排任务');
    expect(screen.getByText(/失败摘要：EIP 分配失败/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看任务 job-1' }));

    await screen.findByText('步骤日志');
    expect(screen.getAllByText(/开始时间：2026-06-24 17:30:00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/标准输出摘要：requestRegion=cn-hangzhou/)).toBeTruthy();
  });
});
