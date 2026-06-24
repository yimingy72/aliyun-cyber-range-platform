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
      { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'running', triggeredBy: 'admin' },
    ],
  }),
  fetchProvisionJobDetail: vi.fn().mockResolvedValue({
    job: { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'running', triggeredBy: 'admin' },
    steps: [{ id: 'step-1', jobId: 'job-1', stepName: 'validate', status: 'succeeded', message: '校验通过' }],
  }),
}));

import { ProvisionJobsScreen } from './provision-jobs-screen';

describe('ProvisionJobsScreen', () => {
  it('opens the selected job detail and shows the step log message', async () => {
    render(<ProvisionJobsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('编排任务');
    fireEvent.click(screen.getByRole('button', { name: '查看任务 job-1' }));

    await screen.findByText('步骤日志');
    expect(screen.getByText('校验通过')).toBeTruthy();
  });
});
