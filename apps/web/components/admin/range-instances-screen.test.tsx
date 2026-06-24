import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchAdminBootstrapMock,
  fetchRangeInstanceDetailMock,
  fetchProvisionJobDetailMock,
  triggerRangeActionMock,
} = vi.hoisted(() => ({
  fetchAdminBootstrapMock: vi.fn(),
  fetchRangeInstanceDetailMock: vi.fn(),
  fetchProvisionJobDetailMock: vi.fn(),
  triggerRangeActionMock: vi.fn(),
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
  fetchRangeInstanceDetail: fetchRangeInstanceDetailMock,
  fetchProvisionJobDetail: fetchProvisionJobDetailMock,
  triggerRangeAction: triggerRangeActionMock,
}));

import { RangeInstancesScreen } from './range-instances-screen';

describe('RangeInstancesScreen', () => {
  beforeEach(() => {
    fetchAdminBootstrapMock.mockReset();
    fetchRangeInstanceDetailMock.mockReset();
    fetchProvisionJobDetailMock.mockReset();
    triggerRangeActionMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('filters instances and shows recent job detail in the detail panel', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [
        { id: 'competition-1', name: '总决赛' },
        { id: 'competition-2', name: '区域赛' },
      ],
      teams: [
        { id: 'team-1', name: '蓝队', competitionId: 'competition-1' },
        { id: 'team-2', name: '红队', competitionId: 'competition-2' },
      ],
      rangeTemplates: [
        { id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' },
        { id: 'template-2', name: 'Web 靶场', slug: 'web-range', version: 'v2' },
      ],
      rangeInstances: [
        {
          id: 'range-1',
          teamId: 'team-1',
          competitionId: 'competition-1',
          templateId: 'template-1',
          status: 'running',
          lastJobId: 'job-1',
          errorSummary: null,
          expiresAt: '2026-06-30T08:00:00.000Z',
          accessEntry: { publicIp: '47.1.1.1', url: 'https://range-1.example.com' },
        },
        {
          id: 'range-2',
          teamId: 'team-2',
          competitionId: 'competition-2',
          templateId: 'template-2',
          status: 'create_failed',
          lastJobId: 'job-2',
          errorSummary: '规格不可售',
          expiresAt: '2026-07-01T08:00:00.000Z',
          accessEntry: { publicIp: '47.2.2.2', url: 'https://range-2.example.com' },
        },
      ],
      provisionJobs: [
        { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'running', triggeredBy: 'admin' },
        { id: 'job-2', rangeInstanceId: 'range-2', jobType: 'create', status: 'failed', triggeredBy: 'ops' },
      ],
    });
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      status: 'running',
      teamId: 'team-1',
      competitionId: 'competition-1',
      templateId: 'template-1',
      lastJobId: 'job-1',
      expiresAt: '2026-06-30T08:00:00.000Z',
      accessEntry: {
        hostRole: 'bastion',
        publicIp: '47.1.1.1',
        privateIp: '172.16.0.10',
        ssh: 'ssh root@47.1.1.1',
        url: 'https://range-1.example.com',
      },
      resourceSummary: { mode: 'dedicated', vpcId: 'vpc-123', topologySpec: { vpcCidr: '172.16.0.0/16' } },
    });
    fetchProvisionJobDetailMock.mockResolvedValue({
      job: {
        id: 'job-1',
        rangeInstanceId: 'range-1',
        jobType: 'create',
        status: 'running',
        triggeredBy: 'admin',
        errorSummary: null,
      },
      steps: [
        {
          id: 'step-1',
          jobId: 'job-1',
          stepName: 'allocate-eip',
          status: 'succeeded',
          message: '已分配公网入口',
          stdoutExcerpt: 'publicIp=47.1.1.1',
        },
      ],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('靶场实例');
    fireEvent.change(screen.getByLabelText('比赛筛选'), { target: { value: 'competition-1' } });

    expect(screen.getByText('总决赛')).toBeTruthy();
    expect(screen.getByText('企业攻防靶场')).toBeTruthy();
    expect(screen.queryByText('range-2')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '查看实例 range-1' }));

    await screen.findByText('公网入口详情');
    expect(screen.getByText(/公网 IP：47.1.1.1/)).toBeTruthy();
    expect(screen.getByText('最近一次任务')).toBeTruthy();
    expect(screen.getByText(/allocate-eip\s*\/\s*成功\s*\/\s*已分配公网入口/)).toBeTruthy();
  });

  it('uses the latest job summary and only shows legal actions for the selected instance', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [{ id: 'competition-1', name: '总决赛' }],
      teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
      rangeTemplates: [{ id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' }],
      rangeInstances: [
        {
          id: 'range-1',
          teamId: 'team-1',
          competitionId: 'competition-1',
          templateId: 'template-1',
          status: 'running',
          lastJobId: 'job-new',
          errorSummary: null,
          accessEntry: { publicIp: '47.1.1.1' },
        },
      ],
      provisionJobs: [
        { id: 'job-new', rangeInstanceId: 'range-1', jobType: 'destroy', status: 'pending', triggeredBy: 'admin', startedAt: '2026-06-24T10:00:00.000Z' },
        { id: 'job-old', rangeInstanceId: 'range-1', jobType: 'create', status: 'succeeded', triggeredBy: 'admin', startedAt: '2026-06-24T09:00:00.000Z' },
      ],
    });
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      status: 'running',
      teamId: 'team-1',
      competitionId: 'competition-1',
      templateId: 'template-1',
      lastJobId: 'job-new',
      accessEntry: { publicIp: '47.1.1.1' },
      resourceSummary: { vpcId: 'vpc-123' },
    });
    fetchProvisionJobDetailMock.mockResolvedValue({
      job: { id: 'job-new', rangeInstanceId: 'range-1', jobType: 'destroy', status: 'pending', triggeredBy: 'admin' },
      steps: [],
    });
    triggerRangeActionMock.mockResolvedValue({
      id: 'job-after',
      rangeInstanceId: 'range-1',
      jobType: 'destroy',
      status: 'pending',
      triggeredBy: 'admin',
      startedAt: '2026-06-24T11:00:00.000Z',
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText(/最近任务：处理中/);
    fireEvent.click(screen.getByRole('button', { name: '查看实例 range-1' }));

    await screen.findByText('最近一次任务');
    expect(screen.queryByRole('button', { name: '发起创建' })).toBeNull();
    expect(screen.getByRole('button', { name: '发起销毁' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '发起销毁' }));

    await screen.findByText(/最近任务：处理中/);
    expect(triggerRangeActionMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'range-1', 'destroy', 'admin');
  });
});
