import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchAdminBootstrapMock, fetchProvisionJobDetailMock } = vi.hoisted(() => ({
  fetchAdminBootstrapMock: vi.fn(),
  fetchProvisionJobDetailMock: vi.fn(),
}));

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
  fetchAdminBootstrap: fetchAdminBootstrapMock,
  fetchProvisionJobDetail: fetchProvisionJobDetailMock,
}));

import { ProvisionJobsScreen } from './provision-jobs-screen';

describe('ProvisionJobsScreen', () => {
  beforeEach(() => {
    fetchAdminBootstrapMock.mockReset();
    fetchProvisionJobDetailMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows started time, failure summary, and step log output in job detail', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
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
    });
    fetchProvisionJobDetailMock.mockResolvedValue({
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
    });

    render(<ProvisionJobsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('编排任务');
    expect(screen.getByText(/失败摘要：EIP 分配失败/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看任务 job-1' }));

    await screen.findByText('步骤日志');
    expect(screen.getAllByText(/开始时间：2026-06-24 17:30:00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/标准输出摘要：requestRegion=cn-hangzhou/)).toBeTruthy();
  });

  it('keeps the last clicked job detail when slower earlier requests resolve later', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [],
      teams: [],
      rangeTemplates: [],
      rangeInstances: [],
      provisionJobs: [
        { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'running', triggeredBy: 'admin' },
        { id: 'job-2', rangeInstanceId: 'range-2', jobType: 'destroy', status: 'failed', triggeredBy: 'ops' },
      ],
    });

    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    fetchProvisionJobDetailMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    render(<ProvisionJobsScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('编排任务');
    fireEvent.click(screen.getByRole('button', { name: '查看任务 job-1' }));
    fireEvent.click(screen.getByRole('button', { name: '查看任务 job-2' }));

    resolveSecond({
      job: {
        id: 'job-2',
        rangeInstanceId: 'range-2',
        jobType: 'destroy',
        status: 'failed',
        triggeredBy: 'ops',
      },
      steps: [
        {
          id: 'step-2',
          jobId: 'job-2',
          stepName: 'release-eip',
          status: 'failed',
          message: '资源释放失败',
        },
      ],
    });
    await screen.findByText(/当前步骤：release-eip/);

    resolveFirst({
      job: {
        id: 'job-1',
        rangeInstanceId: 'range-1',
        jobType: 'create',
        status: 'running',
        triggeredBy: 'admin',
      },
      steps: [
        {
          id: 'step-1',
          jobId: 'job-1',
          stepName: 'allocate-eip',
          status: 'running',
          message: '旧请求返回',
        },
      ],
    });

    expect(await screen.findByText(/当前步骤：release-eip/)).toBeTruthy();
    expect(screen.queryByText(/当前步骤：allocate-eip/)).toBeNull();
    expect(screen.queryByText('旧请求返回')).toBeNull();
  });
});
