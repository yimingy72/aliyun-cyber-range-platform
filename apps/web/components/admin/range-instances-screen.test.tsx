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

const { pushMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
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
    pushMock.mockReset();
    replaceMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('creates and immediately starts a range instance from the admin page', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [{ id: 'competition-1', name: '总决赛' }],
      teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
      rangeTemplates: [
        {
          id: 'template-1',
          name: '企业攻防靶场',
          slug: 'enterprise-range',
          version: 'v1',
          currentPublishedVersionId: 'published-1',
        },
      ],
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
    triggerRangeActionMock.mockResolvedValue({
      id: 'job-1',
      rangeInstanceId: 'range-1',
      jobType: 'create',
      status: 'pending',
      triggeredBy: 'admin',
    });
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      competitionId: 'competition-1',
      teamId: 'team-1',
      templateId: 'template-1',
      status: 'pending_create',
      errorSummary: null,
      expiresAt: null,
      accessEntry: null,
      resourceSummary: null,
      lastJobId: 'job-1',
    });
    fetchProvisionJobDetailMock.mockResolvedValue({
      job: {
        id: 'job-1',
        rangeInstanceId: 'range-1',
        jobType: 'create',
        status: 'pending',
        triggeredBy: 'admin',
      },
      steps: [],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '创建并启动' }));

    await waitFor(() => {
      expect(createRangeInstanceMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', {
        competitionId: 'competition-1',
        teamId: 'team-1',
        templateId: 'template-1',
      });
    });
    expect(triggerRangeActionMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'range-1',
      'create',
      'admin',
    );

    await waitFor(() => {
      expect(screen.getByText('状态：待创建')).toBeTruthy();
    });
  });

  it('only offers published templates in the create form', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [{ id: 'competition-1', name: '总决赛' }],
      teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
      rangeTemplates: [
        { id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1', currentPublishedVersionId: 'published-1' },
        { id: 'template-2', name: '草稿模板', slug: 'draft-range', version: 'v2', currentPublishedVersionId: null },
      ],
      rangeInstances: [],
      provisionJobs: [],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('创建实例');
    const createTemplateSelect = screen.getByLabelText('靶场模板');
    expect(createTemplateSelect.textContent ?? '').toContain('企业攻防靶场');
    expect(createTemplateSelect.textContent ?? '').not.toContain('草稿模板');
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
          recoverySummary: {
            category: 'capacity',
            severity: 'warning',
            canRetry: true,
            summary: '当前可用区没有匹配的可售实例规格',
            suggestions: ['切换可用区或调整实例规格偏好后再重试。'],
          },
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

  it('filters instances by recovery category', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [{ id: 'competition-1', name: '总决赛' }],
      teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
      rangeTemplates: [{ id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' }],
      rangeInstances: [
        {
          id: 'range-capacity',
          teamId: 'team-1',
          competitionId: 'competition-1',
          templateId: 'template-1',
          status: 'create_failed',
          lastJobId: 'job-capacity',
          errorSummary: 'No saleable ECS instance type found',
          recoverySummary: {
            category: 'capacity',
            severity: 'warning',
            canRetry: true,
            summary: '当前可用区没有匹配的可售实例规格',
            suggestions: ['切换可用区或调整实例规格偏好后再重试。'],
          },
        },
        {
          id: 'range-credentials',
          teamId: 'team-1',
          competitionId: 'competition-1',
          templateId: 'template-1',
          status: 'create_failed',
          lastJobId: 'job-credentials',
          errorSummary: 'Missing required OpenTofu setting',
          recoverySummary: {
            category: 'credentials',
            severity: 'critical',
            canRetry: false,
            summary: 'Runner 缺少必要的云凭证或环境配置',
            suggestions: ['检查阿里云 AccessKey、区域配置和 Runner 环境变量。'],
          },
        },
      ],
      provisionJobs: [],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('靶场实例');
    fireEvent.change(screen.getByLabelText('恢复分类筛选'), { target: { value: 'credentials' } });

    expect(screen.getByText('range-credentials')).toBeTruthy();
    expect(screen.queryByText('range-capacity')).toBeNull();
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

  it('shows failed step summary and retry action for create_failed instances', async () => {
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
          status: 'create_failed',
          lastJobId: 'job-failed',
          errorSummary: 'OpenTofu plan failed',
          accessEntry: null,
        },
      ],
      provisionJobs: [
        { id: 'job-failed', rangeInstanceId: 'range-1', jobType: 'create', status: 'failed', triggeredBy: 'admin', errorSummary: 'OpenTofu plan failed' },
      ],
    });
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-1',
      status: 'create_failed',
      teamId: 'team-1',
      competitionId: 'competition-1',
      templateId: 'template-1',
      lastJobId: 'job-failed',
      errorSummary: 'OpenTofu plan failed',
      accessEntry: null,
      resourceSummary: null,
      recoverySummary: {
        category: 'capacity',
        severity: 'warning',
        canRetry: true,
        summary: '当前可用区没有匹配的可售实例规格',
        suggestions: ['切换可用区或调整实例规格偏好后再重试。'],
      },
    });
    fetchProvisionJobDetailMock.mockResolvedValue({
      job: {
        id: 'job-failed',
        rangeInstanceId: 'range-1',
        jobType: 'create',
        status: 'failed',
        triggeredBy: 'admin',
        errorSummary: 'OpenTofu plan failed',
      },
      steps: [
        {
          id: 'step-1',
          jobId: 'job-failed',
          stepName: 'tofu_plan',
          status: 'failed',
          message: '规格不可售',
          stderrExcerpt: 'No saleable ECS instance type found',
        },
      ],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('靶场实例');
    fireEvent.click(screen.getByRole('button', { name: '查看实例 range-1' }));

    await screen.findByText('最近失败步骤');
    expect(screen.getByText(/当前阶段：tofu_plan \/ 失败/)).toBeTruthy();
    expect(screen.getByText(/失败原因：OpenTofu plan failed/)).toBeTruthy();
    expect(screen.getByText(/摘要：规格不可售/)).toBeTruthy();
    expect(screen.getByText(/错误输出：No saleable ECS instance type found/)).toBeTruthy();
    expect(screen.getByText(/分类：规格容量/)).toBeTruthy();
    expect(screen.getByText(/摘要：当前可用区没有匹配的可售实例规格/)).toBeTruthy();
    expect(screen.getByText(/可重试：是/)).toBeTruthy();
    expect(screen.getByText(/切换可用区或调整实例规格偏好后再重试。/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试创建' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看任务详情' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看任务详情' }));
    expect(pushMock).toHaveBeenCalledWith('/admin/provision-jobs?jobId=job-failed');

    triggerRangeActionMock.mockResolvedValueOnce({
      id: 'job-retry',
      rangeInstanceId: 'range-1',
      jobType: 'retry',
      status: 'pending',
      triggeredBy: 'admin',
    });

    fireEvent.click(screen.getByRole('button', { name: '重试创建' }));
    expect(triggerRangeActionMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'range-1',
      'retry',
      'admin',
    );
  });

  it('disables retry when structured recovery summary marks the failure as non-retryable', async () => {
    fetchAdminBootstrapMock.mockResolvedValue({
      competitions: [{ id: 'competition-1', name: '总决赛' }],
      teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
      rangeTemplates: [{ id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' }],
      rangeInstances: [
        {
          id: 'range-2',
          teamId: 'team-1',
          competitionId: 'competition-1',
          templateId: 'template-1',
          status: 'create_failed',
          lastJobId: 'job-credentials',
          errorSummary: 'Missing required OpenTofu setting',
          accessEntry: null,
        },
      ],
      provisionJobs: [{ id: 'job-credentials', rangeInstanceId: 'range-2', jobType: 'create', status: 'failed', triggeredBy: 'admin' }],
    });
    fetchRangeInstanceDetailMock.mockResolvedValue({
      id: 'range-2',
      status: 'create_failed',
      teamId: 'team-1',
      competitionId: 'competition-1',
      templateId: 'template-1',
      lastJobId: 'job-credentials',
      errorSummary: 'Missing required OpenTofu setting',
      accessEntry: null,
      resourceSummary: null,
      recoverySummary: {
        category: 'credentials',
        severity: 'critical',
        canRetry: false,
        summary: 'Runner 缺少必要的云凭证或环境配置',
        suggestions: ['检查阿里云 AccessKey、区域配置和 Runner 环境变量。'],
      },
    });
    fetchProvisionJobDetailMock.mockResolvedValue({
      job: {
        id: 'job-credentials',
        rangeInstanceId: 'range-2',
        jobType: 'create',
        status: 'failed',
        triggeredBy: 'admin',
        errorSummary: 'Missing required OpenTofu setting',
      },
      steps: [],
    });

    render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

    await screen.findByText('靶场实例');
    fireEvent.click(screen.getByRole('button', { name: '查看实例 range-2' }));

    await screen.findByText(/分类：云凭证配置/);
    expect(screen.getByText(/可重试：否/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '重试创建' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
