import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createRangeInstanceMock,
  fetchAdminBootstrapMock,
  fetchRangeInstanceDetailMock,
  fetchProvisionJobDetailMock,
  triggerRangeActionMock,
} = vi.hoisted(() => ({
  createRangeInstanceMock: vi.fn(),
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
  createRangeInstance: createRangeInstanceMock,
  fetchAdminBootstrap: fetchAdminBootstrapMock,
  fetchRangeInstanceDetail: fetchRangeInstanceDetailMock,
  fetchProvisionJobDetail: fetchProvisionJobDetailMock,
  triggerRangeAction: triggerRangeActionMock,
}));

import { RangeInstancesScreen } from './range-instances-screen';

describe('RangeInstancesScreen', () => {
  beforeEach(() => {
    createRangeInstanceMock.mockReset();
    fetchAdminBootstrapMock.mockReset();
    fetchRangeInstanceDetailMock.mockReset();
    fetchProvisionJobDetailMock.mockReset();
    triggerRangeActionMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('creates a draft range instance from the admin page', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [{ id: 'competition-1', name: '总决赛' }],
      teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
      rangeTemplates: [{ id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' }],
      rangeInstances: [],
      provisionJobs: [],
    });
    createRangeInstanceMock.mockResolvedValue({
      id: 'range-1',
      competitionId: 'competition-1',
      teamId: 'team-1',
      templateId: 'template-1',
      status: 'draft',
      errorSummary: null,
      expiresAt: null,
      accessEntry: null,
      resourceSummary: null,
      lastJobId: null,
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '创建实例' }));

    await waitFor(() => {
      expect(createRangeInstanceMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', {
        competitionId: 'competition-1',
        teamId: 'team-1',
        templateId: 'template-1',
      });
    });

    await screen.findByText('range-1');
    expect(screen.getByText('状态：草稿')).toBeTruthy();
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

    expect(screen.getByText(/比赛：总决赛/)).toBeTruthy();
    expect(screen.getByText(/模板：企业攻防靶场/)).toBeTruthy();
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
        { id: 'job-new', rangeInstanceId: 'range-1', jobType: 'destroy', status: 'pending', triggeredBy: 'admin' },
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

  it('keeps the first job in backend order as latest even when pending jobs have no startedAt', async () => {
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
          lastJobId: 'job-pending',
          errorSummary: null,
          accessEntry: { publicIp: '47.1.1.1' },
        },
      ],
      provisionJobs: [
        { id: 'job-pending', rangeInstanceId: 'range-1', jobType: 'destroy', status: 'pending', triggeredBy: 'admin' },
        { id: 'job-old', rangeInstanceId: 'range-1', jobType: 'create', status: 'succeeded', triggeredBy: 'admin', startedAt: '2026-06-24T09:00:00.000Z' },
      ],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText(/最近任务：处理中/);
    expect(screen.queryByText(/最近任务：成功/)).toBeNull();
  });

  it('clears old step logs after triggering a new pending job', async () => {
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
          lastJobId: 'job-old',
          errorSummary: null,
          accessEntry: { publicIp: '47.1.1.1' },
        },
      ],
      provisionJobs: [
        { id: 'job-old', rangeInstanceId: 'range-1', jobType: 'create', status: 'succeeded', triggeredBy: 'admin', startedAt: '2026-06-24T09:00:00.000Z' },
      ],
    });
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      status: 'running',
      teamId: 'team-1',
      competitionId: 'competition-1',
      templateId: 'template-1',
      lastJobId: 'job-old',
      accessEntry: { publicIp: '47.1.1.1' },
      resourceSummary: { vpcId: 'vpc-123' },
    });
    fetchProvisionJobDetailMock.mockResolvedValue({
      job: { id: 'job-old', rangeInstanceId: 'range-1', jobType: 'create', status: 'succeeded', triggeredBy: 'admin' },
      steps: [{ id: 'step-old', jobId: 'job-old', stepName: 'allocate-eip', status: 'succeeded', message: '旧步骤日志' }],
    });
    triggerRangeActionMock.mockResolvedValue({
      id: 'job-new',
      rangeInstanceId: 'range-1',
      jobType: 'destroy',
      status: 'pending',
      triggeredBy: 'admin',
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('靶场实例');
    fireEvent.click(screen.getByRole('button', { name: '查看实例 range-1' }));
    await screen.findByText(/allocate-eip\s*\/\s*成功\s*\/\s*旧步骤日志/);

    fireEvent.click(screen.getByRole('button', { name: '发起销毁' }));

    await screen.findByText(/任务 ID：job-new/);
    expect(screen.queryByText('旧步骤日志')).toBeNull();
    expect(screen.getByText('暂无步骤日志。')).toBeTruthy();
  });

  it('refreshes instance detail and latest steps after create job starts', async () => {
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
          status: 'draft',
          lastJobId: null,
          errorSummary: null,
          accessEntry: null,
        },
      ],
      provisionJobs: [],
    });
    fetchRangeInstanceDetailMock
      .mockResolvedValueOnce({
        id: 'range-1',
        status: 'draft',
        teamId: 'team-1',
        competitionId: 'competition-1',
        templateId: 'template-1',
        lastJobId: null,
        accessEntry: null,
        resourceSummary: null,
      })
      .mockResolvedValueOnce({
        id: 'range-1',
        status: 'running',
        teamId: 'team-1',
        competitionId: 'competition-1',
        templateId: 'template-1',
        lastJobId: 'job-1',
        accessEntry: {
          hostRole: 'dmz',
          publicIp: '47.1.1.1',
          url: 'https://range.local/range-1',
        },
        resourceSummary: {
          mode: 'dry-run',
          vpcId: 'vpc-123',
        },
      });
    fetchProvisionJobDetailMock.mockResolvedValue({
      job: {
        id: 'job-1',
        rangeInstanceId: 'range-1',
        jobType: 'create',
        status: 'succeeded',
        triggeredBy: 'admin',
      },
      steps: [
        {
          id: 'step-1',
          jobId: 'job-1',
          stepName: 'collect_outputs',
          status: 'succeeded',
          message: '已写入入口信息',
        },
      ],
    });
    triggerRangeActionMock.mockResolvedValue({
      id: 'job-1',
      rangeInstanceId: 'range-1',
      jobType: 'create',
      status: 'pending',
      triggeredBy: 'admin',
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" pollIntervalMs={10} />);

    await screen.findByText('靶场实例');
    fireEvent.click(screen.getByRole('button', { name: '查看实例 range-1' }));
    await screen.findByRole('button', { name: '发起创建' });
    fireEvent.click(screen.getByRole('button', { name: '发起创建' }));

    await waitFor(() => {
      expect(triggerRangeActionMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'range-1', 'create', 'admin');
    });

    await waitFor(() => {
      expect(fetchRangeInstanceDetailMock).toHaveBeenCalledTimes(2);
      expect(fetchProvisionJobDetailMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'job-1');
      expect(screen.getByText('状态：运行中')).toBeTruthy();
      expect(screen.getByText(/collect_outputs\s*\/\s*成功\s*\/\s*已写入入口信息/)).toBeTruthy();
    });
  });
});
